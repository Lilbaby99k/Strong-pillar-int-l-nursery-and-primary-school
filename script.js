/* ============================================================================
   Strong Pillar Int'l Nursery and Primary School — Result Management System
   script.js — Phase 1: Supabase client, app state, auth, router, sidebar.
   Later phases add functions in clearly labeled sections below; nothing here
   should need to be rewritten to grow into a multi-file project later.
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
   3. NAV CONFIG PER ROLE
   Each entry: { key, label, icon }. key must match a #view-<key> element id
   (added to index.html as each phase builds that screen). Views not yet
   built simply show a "coming in a later phase" placeholder via navigateTo().
   ---------------------------------------------------------------------------- */
const NAV_BY_ROLE = {
  admin: [
    { key: 'dashboard', label: 'Dashboard', icon: '◆' },
    { key: 'students', label: 'Students', icon: '◆' },
    { key: 'staff', label: 'Staff & Teachers', icon: '◆' },
    { key: 'parents', label: 'Parents', icon: '◆' },
    { key: 'classes', label: 'Classes & Subjects', icon: '◆' },
    { key: 'approvals', label: 'Result Approvals', icon: '◆' },
    { key: 'reportcards', label: 'Report Cards', icon: '◆' },
    { key: 'promotions', label: 'Promotions & Transfers', icon: '◆' },
    { key: 'attendance', label: 'Attendance', icon: '◆' },
    { key: 'announcements', label: 'Announcements', icon: '◆' },
    { key: 'calendar', label: 'Calendar', icon: '◆' },
    { key: 'auditlog', label: 'Audit Log', icon: '◆' },
    { key: 'settings', label: 'School Settings', icon: '◆' },
  ],
  teacher: [
    { key: 'dashboard', label: 'Dashboard', icon: '◆' },
    { key: 'myclass', label: 'My Class', icon: '◆' },
    { key: 'results', label: 'Enter Results', icon: '◆' },
    { key: 'attendance', label: 'Attendance', icon: '◆' },
    { key: 'reportcards', label: 'Report Cards', icon: '◆' },
    { key: 'announcements', label: 'Announcements', icon: '◆' },
  ],
  parent: [
    { key: 'dashboard', label: 'Dashboard', icon: '◆' },
    { key: 'reportcards', label: 'Report Cards', icon: '◆' },
    { key: 'attendance', label: 'Attendance', icon: '◆' },
    { key: 'announcements', label: 'Announcements', icon: '◆' },
    { key: 'calendar', label: 'Calendar', icon: '◆' },
  ],
};

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
async function handleLoginSubmit(event) {
  event.preventDefault();
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  const errorEl = document.getElementById('login-error');
  const submitBtn = document.getElementById('login-submit-btn');

  errorEl.classList.add('hidden');
  submitBtn.disabled = true;
  showLoading();

  try {
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

async function loadUserProfileAndEnterApp(authUser) {
  let { data: profile } = await supabaseClient
    .from('users')
    .select('id, role, full_name, email, phone, is_active')
    .eq('id', authUser.id)
    .maybeSingle();

  if (!profile) {
    const claimed = await tryClaimPendingAccount(authUser);
    if (!claimed) {
      showToast('Your account has no profile record. Contact the administrator.', 'error');
      await supabaseClient.auth.signOut();
      return;
    }
    const refetch = await supabaseClient
      .from('users')
      .select('id, role, full_name, email, phone, is_active')
      .eq('id', authUser.id)
      .single();
    profile = refetch.data;
  }

  if (!profile) {
    showToast('Could not load your profile. Please try signing in again.', 'error');
    await supabaseClient.auth.signOut();
    return;
  }

  if (!profile.is_active) {
    showToast('This account has been deactivated. Contact the administrator.', 'error');
    await supabaseClient.auth.signOut();
    return;
  }

  setState({ authUser, user: profile });
  await loadSchoolSettings();
  await loadActiveSessionAndTerm();

  if (!appState.schoolSettings || !appState.schoolSettings.setup_completed) {
    if (profile.role === 'admin') {
      showView('wizard');
      initWizard();
    } else {
      showToast('The system has not been set up yet. Please contact your administrator.', 'error');
      await supabaseClient.auth.signOut();
      setState({ user: null, authUser: null });
    }
    return;
  }

  enterAppShell();
}

// Looks for a pending_accounts row matching this auth user's email. If one
// exists and is unclaimed, creates their public.users (+ staff/parents) row
// and marks the invite claimed. RLS enforces the same match server-side, so
// this can't be tricked into granting an unauthorized role.
async function tryClaimPendingAccount(authUser) {
  const { data: pending } = await supabaseClient
    .from('pending_accounts')
    .select('*')
    .eq('email', authUser.email)
    .eq('claimed', false)
    .maybeSingle();

  if (!pending) return false;

  const { error: userErr } = await supabaseClient.from('users').insert({
    id: authUser.id,
    role: pending.role,
    full_name: pending.full_name,
    email: pending.email,
    phone: pending.phone,
  });
  if (userErr) {
    showToast(userErr.message, 'error');
    return false;
  }

  if (pending.role === 'admin' || pending.role === 'teacher') {
    await supabaseClient.from('staff').insert({
      id: authUser.id,
      staff_number: pending.staff_number,
      employed_date: pending.employed_date,
    });
  } else {
    await supabaseClient.from('parents').insert({
      id: authUser.id,
      address: pending.address,
    });
  }

  await supabaseClient.from('pending_accounts').update({ claimed: true }).eq('id', pending.id);
  return true;
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

function applySchoolBranding(settings) {
  if (settings.school_name) {
    document.getElementById('login-school-name').textContent = settings.school_name;
    document.getElementById('sidebar-school-name').textContent = settings.school_name;
    document.title = `${settings.school_name} — Result Management System`;
  }
  if (settings.motto) {
    document.getElementById('login-motto').textContent = settings.motto;
  }
  if (settings.theme_color) {
    document.documentElement.style.setProperty('--color-navy', settings.theme_color);
  }
}

async function handleLogout() {
  showLoading();
  await supabaseClient.auth.signOut();
  setState({ user: null, authUser: null, currentView: 'login' });
  hideLoading();
  showView('login');
}

async function handleForgotPassword() {
  const email = document.getElementById('login-email').value.trim();
  if (!email) {
    showToast('Enter your email above first, then click "Forgot password?"', 'error');
    return;
  }
  showLoading();
  const { error } = await supabaseClient.auth.resetPasswordForEmail(email);
  hideLoading();
  if (error) {
    showToast(error.message, 'error');
  } else {
    showToast('Password reset instructions sent to your email.', 'success');
  }
}

/* ---- Activate-account & contact-form toggles ------------------------------ */
function showLoginPanel(panel) {
  document.querySelector('.login-form-pane > .login-form-card').classList.toggle('hidden', panel !== 'signin');
  document.getElementById('activate-form-card').classList.toggle('hidden', panel !== 'activate');
  document.getElementById('contact-form-card').classList.toggle('hidden', panel !== 'contact');
}
function showActivateForm(show) { showLoginPanel(show ? 'activate' : 'signin'); }
function showContactForm(show) { showLoginPanel(show ? 'contact' : 'signin'); }

async function handleContactSubmit(event) {
  event.preventDefault();
  const name = document.getElementById('contact-name').value.trim();
  const email = document.getElementById('contact-email').value.trim();
  const message = document.getElementById('contact-message').value.trim();
  const errorEl = document.getElementById('contact-error');
  const noticeEl = document.getElementById('contact-notice');
  errorEl.classList.add('hidden');
  noticeEl.classList.add('hidden');

  const webhookUrl = appState.schoolSettings?.apps_script_webhook_url;
  const sendTo = appState.schoolSettings?.email;
  if (!webhookUrl || !sendTo) {
    errorEl.textContent = "This school hasn't set up its contact form yet. Please reach them directly.";
    errorEl.classList.remove('hidden');
    return;
  }

  showLoading();
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      body: JSON.stringify({ type: 'contact', name, email, message, sendTo }),
    });
    const data = await res.json().catch(() => null);
    if (data && data.error) throw new Error(data.error);
    noticeEl.textContent = "Message sent — the school will get back to you.";
    noticeEl.classList.remove('hidden');
    document.getElementById('contact-form').reset();
  } catch (err) {
    errorEl.textContent = err.message || 'Could not send your message. Please try again.';
    errorEl.classList.remove('hidden');
  } finally {
    hideLoading();
  }
}

async function handleActivateSubmit(event) {
  event.preventDefault();
  const email = document.getElementById('activate-email').value.trim();
  const password = document.getElementById('activate-password').value;
  const confirmPassword = document.getElementById('activate-password-confirm').value;
  const errorEl = document.getElementById('activate-error');
  const noticeEl = document.getElementById('activate-notice');
  errorEl.classList.add('hidden');
  noticeEl.classList.add('hidden');

  if (password !== confirmPassword) {
    errorEl.textContent = 'Passwords do not match.';
    errorEl.classList.remove('hidden');
    return;
  }
  if (password.length < 8) {
    errorEl.textContent = 'Password must be at least 8 characters.';
    errorEl.classList.remove('hidden');
    return;
  }

  showLoading();
  try {
    const { data: exists, error: checkErr } = await supabaseClient.rpc('pending_account_exists', { check_email: email });
    if (checkErr) throw checkErr;
    if (!exists) {
      throw new Error('No pending account found for that email. Check with your administrator, or use "Forgot password?" if you already activated.');
    }

    const { data, error } = await supabaseClient.auth.signUp({ email, password });
    if (error) throw error;

    if (data.session && data.user) {
      // Email confirmations are off — signUp() already returned a session.
      await loadUserProfileAndEnterApp(data.user);
    } else {
      noticeEl.textContent = 'Account created. Check your email to confirm it, then come back and sign in with your new password.';
      noticeEl.classList.remove('hidden');
    }
  } catch (err) {
    errorEl.textContent = err.message || 'Could not activate account.';
    errorEl.classList.remove('hidden');
  } finally {
    hideLoading();
  }
}

/* ----------------------------------------------------------------------------
   6. VIEW SWITCHING (login screen vs. app shell)
   ---------------------------------------------------------------------------- */
function showView(name) {
  document.getElementById('view-login').classList.toggle('hidden', name !== 'login');
  document.getElementById('view-wizard').classList.toggle('hidden', name !== 'wizard');
  document.getElementById('view-app').classList.toggle('hidden', name !== 'app');
}

function enterAppShell() {
  showView('app');
  renderSidebar();
  renderUserSummary();
  renderTopbarContext();
  navigateTo('dashboard');
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
function navigateTo(viewKey) {
  setState({ currentView: viewKey });

  document.querySelectorAll('.sidebar-nav-item').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.viewKey === viewKey);
  });

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

// Screens that need to (re)fetch their data every time the admin navigates
// to them. Kept as one dispatch table rather than scattering calls through
// navigateTo(), so adding a new screen in a later phase is a one-line add.
const VIEW_LOAD_HANDLERS = {
  dashboard: loadDashboardAnalytics,
  staff: loadStaffScreen,
  parents: loadParentsScreen,
  classes: loadClassesScreen,
  students: loadStudentsScreen,
  myclass: loadMyClassScreen,
  results: loadResultsScreen,
  approvals: loadApprovalsScreen,
  reportcards: loadReportCardsScreen,
  promotions: loadPromotionsScreen,
  attendance: loadAttendanceScreen,
  announcements: loadAnnouncementsScreen,
  calendar: loadCalendarScreen,
  auditlog: loadAuditLogScreen,
  settings: loadSettingsScreen,
};

function dispatchViewLoad(viewKey) {
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
   10. SETUP WIZARD (Phase 2)
   Only reachable by an admin, only while school_settings.setup_completed
   is false. Each step writes directly to its real table (no separate
   "wizard data" store), so partial progress is never lost if the admin
   closes the tab mid-way — reopening simply re-shows the wizard from
   step 1, and steps are idempotent (upsert/replace) to make re-running
   them safe.
   ---------------------------------------------------------------------------- */
const wizardState = { currentStep: 1 };

function initWizard() {
  wizardState.currentStep = 1;
  goToWizardStep(1);
  populateGradingStepFromExisting();
  if (document.getElementById('wizard-class-rows').children.length === 0) {
    addWizardClassRow();
  }
}

function goToWizardStep(n) {
  wizardState.currentStep = n;
  document.querySelectorAll('.wizard-step-form').forEach(el => {
    el.classList.toggle('hidden', Number(el.dataset.step) !== n);
  });
  document.querySelectorAll('#wizard-step-list li').forEach(li => {
    const step = Number(li.dataset.step);
    li.classList.toggle('active', step === n);
    li.classList.toggle('done', step < n);
  });
  if (n === 6) renderWizardAdminList();
}

async function uploadSchoolAsset(file, folder) {
  if (!file) return null;
  const ext = file.name.split('.').pop();
  const path = `${folder}/${Date.now()}.${ext}`;
  const { error } = await supabaseClient.storage.from('school-assets').upload(path, file, { upsert: true });
  if (error) {
    showToast(`Upload failed: ${error.message}`, 'error');
    return null;
  }
  const { data } = supabaseClient.storage.from('school-assets').getPublicUrl(path);
  return data.publicUrl;
}

/* ---- Step 1: School Identity --------------------------------------------- */
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('wizard-step-1').addEventListener('submit', async (e) => {
    e.preventDefault();
    showLoading();
    try {
      const logoFile = document.getElementById('wz-logo-file').files[0];
      const signatureFile = document.getElementById('wz-signature-file').files[0];

      const patch = {
        school_name: document.getElementById('wz-school-name').value.trim(),
        motto: document.getElementById('wz-motto').value.trim(),
        phone: document.getElementById('wz-phone').value.trim(),
        email: document.getElementById('wz-email').value.trim(),
        address: document.getElementById('wz-address').value.trim(),
        principal_name: document.getElementById('wz-principal-name').value.trim(),
        updated_at: new Date().toISOString(),
      };

      const logoUrl = await uploadSchoolAsset(logoFile, 'logo');
      if (logoUrl) patch.logo_url = logoUrl;
      const signatureUrl = await uploadSchoolAsset(signatureFile, 'signatures');
      if (signatureUrl) patch.principal_signature_url = signatureUrl;

      const { data, error } = await supabaseClient.from('school_settings').update(patch).eq('id', true).select().single();
      if (error) throw error;

      setState({ schoolSettings: data });
      applySchoolBranding(data);
      showToast('School identity saved.', 'success');
      goToWizardStep(2);
    } catch (err) {
      showToast(err.message || 'Could not save school identity.', 'error');
    } finally {
      hideLoading();
    }
  });

  /* ---- Step 2: Academic Session & Terms --------------------------------- */
  document.getElementById('wizard-step-2').addEventListener('submit', async (e) => {
    e.preventDefault();
    showLoading();
    try {
      const sessionName = document.getElementById('wz-session-name').value.trim();
      const currentTermName = document.querySelector('input[name="wz-current-term"]:checked').value;

      const { data: session, error: sessionErr } = await supabaseClient
        .from('sessions')
        .insert({ name: sessionName, is_active: true })
        .select()
        .single();
      if (sessionErr) throw sessionErr;

      const termRows = Array.from(document.querySelectorAll('.wizard-term-row')).map(row => ({
        session_id: session.id,
        name: row.dataset.term,
        start_date: row.querySelector('[data-field="start"]').value || null,
        end_date: row.querySelector('[data-field="end"]').value || null,
        is_current: row.dataset.term === currentTermName,
        is_result_entry_open: false,
      }));

      const { data: insertedTerms, error: termsErr } = await supabaseClient.from('terms').insert(termRows).select();
      if (termsErr) throw termsErr;

      const currentTerm = insertedTerms.find(t => t.name === currentTermName);
      setState({ activeSessionId: session.id, activeTermId: currentTerm ? currentTerm.id : null });

      showToast('Academic session and terms saved.', 'success');
      goToWizardStep(3);
    } catch (err) {
      showToast(err.message || 'Could not save session/terms.', 'error');
    } finally {
      hideLoading();
    }
  });

  /* ---- Step 3: Classes & Arms -------------------------------------------- */
  document.getElementById('wizard-add-class-row').addEventListener('click', addWizardClassRow);

  document.getElementById('wizard-step-3').addEventListener('submit', async (e) => {
    e.preventDefault();
    showLoading();
    try {
      const rows = Array.from(document.querySelectorAll('#wizard-class-rows .wizard-repeat-row'))
        .map(row => ({
          className: row.querySelector('[data-field="class-name"]').value.trim(),
          arms: row.querySelector('[data-field="class-arms"]').value.trim(),
        }))
        .filter(r => r.className);

      if (rows.length === 0) throw new Error('Add at least one class before continuing.');

      for (let i = 0; i < rows.length; i++) {
        const { className, arms } = rows[i];
        const { data: cls, error: clsErr } = await supabaseClient
          .from('classes')
          .insert({ name: className, sort_order: i })
          .select()
          .single();
        if (clsErr) throw clsErr;

        const armNames = arms ? arms.split(',').map(a => a.trim()).filter(Boolean) : ['A'];
        const armRows = armNames.map(name => ({ class_id: cls.id, name }));
        const { error: armErr } = await supabaseClient.from('class_arms').insert(armRows);
        if (armErr) throw armErr;
      }

      showToast('Classes and arms saved.', 'success');
      goToWizardStep(4);
    } catch (err) {
      showToast(err.message || 'Could not save classes.', 'error');
    } finally {
      hideLoading();
    }
  });

  /* ---- Step 4: Subjects --------------------------------------------------- */
  document.getElementById('wizard-step-4').addEventListener('submit', async (e) => {
    e.preventDefault();
    showLoading();
    try {
      const names = document.getElementById('wz-subjects-textarea').value
        .split('\n').map(s => s.trim()).filter(Boolean);
      if (names.length === 0) throw new Error('Add at least one subject before continuing.');

      const { data: subjects, error: subjErr } = await supabaseClient
        .from('subjects')
        .insert(names.map(name => ({ name })))
        .select();
      if (subjErr) throw subjErr;

      const { data: classes, error: classErr } = await supabaseClient.from('classes').select('id');
      if (classErr) throw classErr;

      const links = [];
      classes.forEach(c => subjects.forEach(s => links.push({ class_id: c.id, subject_id: s.id })));
      if (links.length > 0) {
        const { error: linkErr } = await supabaseClient.from('class_subjects').insert(links);
        if (linkErr) throw linkErr;
      }

      showToast('Subjects saved and assigned to all classes.', 'success');
      goToWizardStep(5);
    } catch (err) {
      showToast(err.message || 'Could not save subjects.', 'error');
    } finally {
      hideLoading();
    }
  });

  /* ---- Step 5: Grading System --------------------------------------------- */
  document.getElementById('wizard-add-grade-row').addEventListener('click', () => addWizardGradeRow());

  document.getElementById('wizard-step-5').addEventListener('submit', async (e) => {
    e.preventDefault();
    showLoading();
    try {
      const rows = Array.from(document.querySelectorAll('#wizard-grading-rows .wizard-grading-row')).map(row => ({
        min_score: Number(row.querySelector('[data-field="min"]').value),
        max_score: Number(row.querySelector('[data-field="max"]').value),
        grade: row.querySelector('[data-field="grade"]').value.trim(),
        remark: row.querySelector('[data-field="remark"]').value.trim(),
      }));
      if (rows.some(r => !r.grade || !r.remark || Number.isNaN(r.min_score) || Number.isNaN(r.max_score))) {
        throw new Error('Every grading band needs min, max, grade, and remark.');
      }

      // Replace the seeded/global grading scale wholesale with what's on screen.
      const { error: delErr } = await supabaseClient.from('grading_rules').delete().is('session_id', null);
      if (delErr) throw delErr;
      const { error: insErr } = await supabaseClient.from('grading_rules').insert(rows);
      if (insErr) throw insErr;

      showToast('Grading system saved.', 'success');
      goToWizardStep(6);
    } catch (err) {
      showToast(err.message || 'Could not save grading system.', 'error');
    } finally {
      hideLoading();
    }
  });

  /* ---- Step 6: Administrator confirmation --------------------------------- */
  document.getElementById('wizard-step-6-continue').addEventListener('click', () => goToWizardStep(7));

  /* ---- Step 7: Finish ------------------------------------------------------ */
  document.getElementById('wizard-finish-btn').addEventListener('click', async () => {
    showLoading();
    try {
      const { data, error } = await supabaseClient
        .from('school_settings')
        .update({ setup_completed: true, updated_at: new Date().toISOString() })
        .eq('id', true)
        .select()
        .single();
      if (error) throw error;
      setState({ schoolSettings: data });
      showToast('Setup complete. Welcome to your dashboard.', 'success');
      enterAppShell();
    } catch (err) {
      showToast(err.message || 'Could not finish setup.', 'error');
    } finally {
      hideLoading();
    }
  });

  /* ---- Back buttons (shared across steps) --------------------------------- */
  document.querySelectorAll('.wizard-back-btn').forEach(btn => {
    btn.addEventListener('click', () => goToWizardStep(Math.max(1, wizardState.currentStep - 1)));
  });
});

function addWizardClassRow() {
  const container = document.getElementById('wizard-class-rows');
  const row = document.createElement('div');
  row.className = 'wizard-repeat-row';
  row.innerHTML = `
    <input class="field-input" data-field="class-name" placeholder="Class name, e.g. Primary 1">
    <input class="field-input" data-field="class-arms" placeholder="Arms, e.g. A, B, C">
    <button type="button" class="wizard-remove-row-btn">Remove</button>
  `;
  row.querySelector('.wizard-remove-row-btn').addEventListener('click', () => row.remove());
  container.appendChild(row);
}

function addWizardGradeRow(prefill) {
  const container = document.getElementById('wizard-grading-rows');
  const row = document.createElement('div');
  row.className = 'wizard-grading-row';
  const p = prefill || { min_score: '', max_score: '', grade: '', remark: '' };
  row.innerHTML = `
    <input class="field-input" data-field="min" type="number" placeholder="Min" value="${p.min_score}">
    <input class="field-input" data-field="max" type="number" placeholder="Max" value="${p.max_score}">
    <input class="field-input" data-field="grade" placeholder="Grade" value="${p.grade}">
    <input class="field-input" data-field="remark" placeholder="Remark" value="${p.remark}">
    <button type="button" class="wizard-remove-row-btn">Remove</button>
  `;
  row.querySelector('.wizard-remove-row-btn').addEventListener('click', () => row.remove());
  container.appendChild(row);
}

async function populateGradingStepFromExisting() {
  const container = document.getElementById('wizard-grading-rows');
  if (container.children.length > 0) return; // already populated this session
  const { data } = await supabaseClient.from('grading_rules').select('*').order('min_score', { ascending: false });
  (data || []).forEach(rule => addWizardGradeRow(rule));
  if (!data || data.length === 0) addWizardGradeRow();
}

async function renderWizardAdminList() {
  const { data } = await supabaseClient.from('users').select('full_name, email').eq('role', 'admin');
  const dl = document.getElementById('wizard-admin-list');
  dl.innerHTML = (data || []).map(a => `<div><dt>${a.full_name}</dt><dd>${a.email}</dd></div>`).join('');
}

/* ----------------------------------------------------------------------------
   11. SHARED HELPERS
   ---------------------------------------------------------------------------- */
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Fires an outbound email via the school's Google Apps Script Web App, if
// one has been configured in Settings. Deliberately fire-and-forget: a
// failed or unconfigured notification should never block the underlying
// action (creating an invite, publishing a report card) from succeeding.
// The plain-string body (no custom headers) keeps this a CORS "simple
// request", which is what lets Apps Script Web Apps accept it without a
// preflight OPTIONS call.
async function sendAppsScriptEmail(payload) {
  const url = appState.schoolSettings?.apps_script_webhook_url;
  if (!url) return;
  try {
    await fetch(url, { method: 'POST', body: JSON.stringify(payload) });
  } catch (err) {
    console.warn('Email notification failed to send:', err);
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
let classesWithArmsCache = [];
async function refreshClassesWithArmsCache() {
  const { data: classes } = await supabaseClient.from('classes').select('id, name, sort_order').order('sort_order');
  const { data: arms } = await supabaseClient
    .from('class_arms')
    .select('id, name, class_id, class_teacher_id, staff(users(full_name))');
  classesWithArmsCache = (classes || []).map(c => ({
    ...c,
    arms: (arms || []).filter(a => a.class_id === c.id),
  }));
  return classesWithArmsCache;
}

/* ----------------------------------------------------------------------------
   12. ADMIN CRUD — STAFF & TEACHERS
   ---------------------------------------------------------------------------- */
let staffCache = [];
let staffPage = 1;

async function loadStaffScreen() {
  staffPage = 1;
  const tbody = document.getElementById('staff-table-body');
  tbody.innerHTML = `<tr class="empty-row"><td colspan="7">Loading…</td></tr>`;

  const { data: staffRows, error } = await supabaseClient
    .from('staff')
    .select('id, staff_number, employed_date, users(full_name, email, role, phone)');
  if (error) { showToast(error.message, 'error'); return; }

  const { data: arms } = await supabaseClient
    .from('class_arms')
    .select('id, name, class_teacher_id, classes(name)');

  const activeRows = (staffRows || [])
    .filter(s => s.users)
    .map(s => {
      const arm = (arms || []).find(a => a.class_teacher_id === s.id);
      return {
        pendingId: null,
        full_name: s.users.full_name,
        email: s.users.email,
        role: s.users.role,
        staff_number: s.staff_number,
        assigned_arm: arm ? `${arm.classes.name} ${arm.name}` : '—',
        status: 'active',
      };
    });

  const { data: pendingRows } = await supabaseClient
    .from('pending_accounts')
    .select('*')
    .in('role', ['admin', 'teacher'])
    .eq('claimed', false);

  const pending = (pendingRows || []).map(p => ({
    pendingId: p.id,
    full_name: p.full_name,
    email: p.email,
    role: p.role,
    staff_number: p.staff_number,
    assigned_arm: '—',
    status: 'pending',
  }));

  staffCache = [...activeRows, ...pending];
  renderStaffTable(staffCache);
}

function renderStaffTable(rows) {
  const { pageRows } = paginate(rows, staffPage, 'staff-pagination', (p) => { staffPage = p; renderStaffTable(rows); });
  const tbody = document.getElementById('staff-table-body');
  if (rows.length === 0) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="7">No staff yet — add your first teacher or administrator above.</td></tr>`;
    return;
  }
  tbody.innerHTML = pageRows.map(r => `
    <tr>
      <td>${escapeHtml(r.full_name)}</td>
      <td>${escapeHtml(r.email)}</td>
      <td><span class="badge ${r.role === 'admin' ? 'badge-gold' : 'badge-navy'}">${escapeHtml(r.role)}</span></td>
      <td>${escapeHtml(r.staff_number || '—')}</td>
      <td>${escapeHtml(r.assigned_arm)}</td>
      <td><span class="badge ${r.status === 'active' ? 'badge-success' : 'badge-gold'}">${r.status === 'active' ? 'Active' : 'Pending activation'}</span></td>
      <td>${r.pendingId ? `<button type="button" class="icon-btn icon-btn-danger" data-cancel-pending-staff="${r.pendingId}">Cancel invite</button>` : ''}</td>
    </tr>
  `).join('');

  tbody.querySelectorAll('[data-cancel-pending-staff]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Cancel this pending invite? They will no longer be able to activate with this email.')) return;
      showLoading();
      try {
        const { error } = await supabaseClient.from('pending_accounts').delete().eq('id', btn.dataset.cancelPendingStaff);
        if (error) throw error;
        loadStaffScreen();
      } catch (err) {
        showToast(err.message || 'Could not cancel invite.', 'error');
      } finally {
        hideLoading();
      }
    });
  });
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('staff-add-btn').addEventListener('click', () => toggleInlineForm('staff-form-card', true));
  document.getElementById('staff-form-cancel').addEventListener('click', () => {
    document.getElementById('staff-form').reset();
    toggleInlineForm('staff-form-card', false);
  });
  document.getElementById('staff-search').addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    staffPage = 1;
    renderStaffTable(staffCache.filter(r => r.full_name.toLowerCase().includes(q) || r.email.toLowerCase().includes(q)));
  });

  document.getElementById('staff-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('staff-form-error');
    errorEl.classList.add('hidden');
    showLoading();
    try {
      const fullName = document.getElementById('staff-full-name').value.trim();
      const email = document.getElementById('staff-email').value.trim();
      const { error } = await supabaseClient.from('pending_accounts').insert({
        full_name: fullName,
        email: email,
        phone: document.getElementById('staff-phone').value.trim(),
        role: document.getElementById('staff-role').value,
        staff_number: document.getElementById('staff-number').value.trim() || null,
        employed_date: document.getElementById('staff-employed-date').value || null,
        created_by: appState.user.id,
      });
      if (error) throw error;

      sendAppsScriptEmail({
        type: 'notify',
        to: email,
        subject: `You've been added to ${appState.schoolSettings?.school_name || 'the school'}'s system`,
        body: `Hello ${fullName},\n\nAn account has been set up for you on ${appState.schoolSettings?.school_name || 'the school'}'s Result Management System.\n\nTo activate it, go to the login page, click "Staff or parent? Activate your account," and enter this email address (${email}) along with a password of your choosing.\n\nIf you weren't expecting this, please contact the school administrator.`,
      });

      showToast('Saved. They can now activate their account using this email.', 'success');
      document.getElementById('staff-form').reset();
      toggleInlineForm('staff-form-card', false);
      loadStaffScreen();
    } catch (err) {
      errorEl.textContent = err.message || 'Could not save.';
      errorEl.classList.remove('hidden');
    } finally {
      hideLoading();
    }
  });
});

/* ----------------------------------------------------------------------------
   13. ADMIN CRUD — PARENTS
   ---------------------------------------------------------------------------- */
let parentCache = [];
let parentPage = 1;

async function loadParentsScreen() {
  parentPage = 1;
  const tbody = document.getElementById('parent-table-body');
  tbody.innerHTML = `<tr class="empty-row"><td colspan="6">Loading…</td></tr>`;

  const { data: parentRows, error } = await supabaseClient
    .from('parents')
    .select('id, users(full_name, email, phone)');
  if (error) { showToast(error.message, 'error'); return; }

  const { data: students } = await supabaseClient.from('students').select('parent_id');
  const childCounts = {};
  (students || []).forEach(s => { if (s.parent_id) childCounts[s.parent_id] = (childCounts[s.parent_id] || 0) + 1; });

  const activeRows = (parentRows || [])
    .filter(p => p.users)
    .map(p => ({
      pendingId: null,
      full_name: p.users.full_name,
      email: p.users.email,
      phone: p.users.phone,
      children: childCounts[p.id] || 0,
      status: 'active',
    }));

  const { data: pendingRows } = await supabaseClient
    .from('pending_accounts')
    .select('*')
    .eq('role', 'parent')
    .eq('claimed', false);

  const pending = (pendingRows || []).map(p => ({
    pendingId: p.id,
    full_name: p.full_name,
    email: p.email,
    phone: p.phone,
    children: 0,
    status: 'pending',
  }));

  parentCache = [...activeRows, ...pending];
  renderParentTable(parentCache);
}

function renderParentTable(rows) {
  const { pageRows } = paginate(rows, parentPage, 'parent-pagination', (p) => { parentPage = p; renderParentTable(rows); });
  const tbody = document.getElementById('parent-table-body');
  if (rows.length === 0) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="6">No parents yet — add one above.</td></tr>`;
    return;
  }
  tbody.innerHTML = pageRows.map(r => `
    <tr>
      <td>${escapeHtml(r.full_name)}</td>
      <td>${escapeHtml(r.email)}</td>
      <td>${escapeHtml(r.phone || '—')}</td>
      <td>${r.children}</td>
      <td><span class="badge ${r.status === 'active' ? 'badge-success' : 'badge-gold'}">${r.status === 'active' ? 'Active' : 'Pending activation'}</span></td>
      <td>${r.pendingId ? `<button type="button" class="icon-btn icon-btn-danger" data-cancel-pending-parent="${r.pendingId}">Cancel invite</button>` : ''}</td>
    </tr>
  `).join('');

  tbody.querySelectorAll('[data-cancel-pending-parent]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Cancel this pending invite?')) return;
      showLoading();
      try {
        const { error } = await supabaseClient.from('pending_accounts').delete().eq('id', btn.dataset.cancelPendingParent);
        if (error) throw error;
        loadParentsScreen();
      } catch (err) {
        showToast(err.message || 'Could not cancel invite.', 'error');
      } finally {
        hideLoading();
      }
    });
  });
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('parent-add-btn').addEventListener('click', () => toggleInlineForm('parent-form-card', true));
  document.getElementById('parent-form-cancel').addEventListener('click', () => {
    document.getElementById('parent-form').reset();
    toggleInlineForm('parent-form-card', false);
  });
  document.getElementById('parent-search').addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    parentPage = 1;
    renderParentTable(parentCache.filter(r => r.full_name.toLowerCase().includes(q) || r.email.toLowerCase().includes(q)));
  });

  document.getElementById('parent-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('parent-form-error');
    errorEl.classList.add('hidden');
    showLoading();
    try {
      const fullName = document.getElementById('parent-full-name').value.trim();
      const email = document.getElementById('parent-email').value.trim();
      const { error } = await supabaseClient.from('pending_accounts').insert({
        full_name: fullName,
        email: email,
        phone: document.getElementById('parent-phone').value.trim(),
        address: document.getElementById('parent-address').value.trim(),
        role: 'parent',
        created_by: appState.user.id,
      });
      if (error) throw error;

      sendAppsScriptEmail({
        type: 'notify',
        to: email,
        subject: `You've been added to ${appState.schoolSettings?.school_name || 'the school'}'s system`,
        body: `Hello ${fullName},\n\nA parent account has been set up for you on ${appState.schoolSettings?.school_name || 'the school'}'s Result Management System, so you can view your child's report cards, attendance, and school announcements.\n\nTo activate it, go to the login page, click "Staff or parent? Activate your account," and enter this email address (${email}) along with a password of your choosing.\n\nIf you weren't expecting this, please contact the school administrator.`,
      });

      showToast('Saved. They can now activate their account using this email.', 'success');
      document.getElementById('parent-form').reset();
      toggleInlineForm('parent-form-card', false);
      loadParentsScreen();
    } catch (err) {
      errorEl.textContent = err.message || 'Could not save.';
      errorEl.classList.remove('hidden');
    } finally {
      hideLoading();
    }
  });
});

/* ----------------------------------------------------------------------------
   14. ADMIN CRUD — CLASSES, ARMS & SUBJECTS
   ---------------------------------------------------------------------------- */
let subjectsCache = [];
let teacherOptionsCache = [];

async function loadClassesScreen() {
  await refreshClassesWithArmsCache();
  const { data: teachers } = await supabaseClient
    .from('staff')
    .select('id, users(full_name, role)');
  teacherOptionsCache = (teachers || []).filter(t => t.users && t.users.role === 'teacher');

  const { data: subjects } = await supabaseClient.from('subjects').select('*').order('name');
  subjectsCache = subjects || [];

  renderClassesList();
  renderSubjectsChips();
}

function renderClassesList() {
  const container = document.getElementById('classes-list');
  if (classesWithArmsCache.length === 0) {
    container.innerHTML = `<p class="view-subheading">No classes yet — add one above.</p>`;
    return;
  }
  container.innerHTML = classesWithArmsCache.map(c => `
    <div class="card class-card">
      <div class="class-card-header">
        <h3>${escapeHtml(c.name)}</h3>
        <button type="button" class="icon-btn icon-btn-danger" data-delete-class="${c.id}">Delete class</button>
      </div>
      <div>
        ${c.arms.map(a => `
          <span class="class-arm-chip">
            Arm ${escapeHtml(a.name)}
            <select data-assign-arm="${a.id}" style="border:none;background:none;font-size:12.5px;">
              <option value="">— assign teacher —</option>
              ${teacherOptionsCache.map(t => `<option value="${t.id}" ${t.id === a.class_teacher_id ? 'selected' : ''}>${escapeHtml(t.users.full_name)}</option>`).join('')}
            </select>
            <button type="button" data-delete-arm="${a.id}" title="Remove arm">✕</button>
          </span>
        `).join('')}
      </div>
      <div class="form-actions">
        <input class="field-input" style="max-width:160px;" placeholder="New arm name" data-new-arm-input="${c.id}">
        <button type="button" class="btn btn-ghost-dark" data-add-arm="${c.id}">+ Add arm</button>
      </div>
    </div>
  `).join('');

  container.querySelectorAll('[data-assign-arm]').forEach(sel => {
    sel.addEventListener('change', async () => {
      const armId = sel.dataset.assignArm;
      const teacherId = sel.value || null;
      showLoading();
      try {
        const { error } = await supabaseClient.from('class_arms').update({ class_teacher_id: teacherId }).eq('id', armId);
        if (error) throw error;
        showToast('Class teacher updated.', 'success');
        loadClassesScreen();
      } catch (err) {
        showToast(err.message || 'Could not update.', 'error');
      } finally {
        hideLoading();
      }
    });
  });

  container.querySelectorAll('[data-add-arm]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const classId = btn.dataset.addArm;
      const input = container.querySelector(`[data-new-arm-input="${classId}"]`);
      const name = input.value.trim();
      if (!name) { showToast('Enter an arm name first.', 'error'); return; }
      showLoading();
      try {
        const { error } = await supabaseClient.from('class_arms').insert({ class_id: classId, name });
        if (error) throw error;
        loadClassesScreen();
      } catch (err) {
        showToast(err.message || 'Could not add arm.', 'error');
      } finally {
        hideLoading();
      }
    });
  });

  container.querySelectorAll('[data-delete-arm]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Remove this arm? This cannot be undone if students are enrolled in it.')) return;
      showLoading();
      try {
        const { error } = await supabaseClient.from('class_arms').delete().eq('id', btn.dataset.deleteArm);
        if (error) throw error;
        loadClassesScreen();
      } catch (err) {
        showToast(err.message || 'Could not remove arm.', 'error');
      } finally {
        hideLoading();
      }
    });
  });

  container.querySelectorAll('[data-delete-class]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this entire class, including all its arms? This cannot be undone.')) return;
      showLoading();
      try {
        const { error } = await supabaseClient.from('classes').delete().eq('id', btn.dataset.deleteClass);
        if (error) throw error;
        loadClassesScreen();
      } catch (err) {
        showToast(err.message || 'Could not delete class.', 'error');
      } finally {
        hideLoading();
      }
    });
  });
}

function renderSubjectsChips() {
  const container = document.getElementById('subjects-chip-list');
  if (subjectsCache.length === 0) {
    container.innerHTML = `<p class="view-subheading">No subjects yet.</p>`;
    return;
  }
  container.innerHTML = subjectsCache.map(s => `
    <span class="class-arm-chip">
      ${escapeHtml(s.name)}${s.code ? ` (${escapeHtml(s.code)})` : ''}
      <button type="button" data-delete-subject="${s.id}" title="Remove subject">✕</button>
    </span>
  `).join('');

  container.querySelectorAll('[data-delete-subject]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Remove this subject from all classes?')) return;
      showLoading();
      try {
        const { error } = await supabaseClient.from('subjects').delete().eq('id', btn.dataset.deleteSubject);
        if (error) throw error;
        loadClassesScreen();
      } catch (err) {
        showToast(err.message || 'Could not remove subject.', 'error');
      } finally {
        hideLoading();
      }
    });
  });
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('add-class-btn').addEventListener('click', async () => {
    const name = document.getElementById('new-class-name').value.trim();
    const armsRaw = document.getElementById('new-class-arms').value.trim();
    if (!name) { showToast('Enter a class name.', 'error'); return; }
    showLoading();
    try {
      const { data: cls, error: clsErr } = await supabaseClient
        .from('classes')
        .insert({ name, sort_order: classesWithArmsCache.length })
        .select()
        .single();
      if (clsErr) throw clsErr;

      const armNames = armsRaw ? armsRaw.split(',').map(a => a.trim()).filter(Boolean) : ['A'];
      const { error: armErr } = await supabaseClient
        .from('class_arms')
        .insert(armNames.map(n => ({ class_id: cls.id, name: n })));
      if (armErr) throw armErr;

      document.getElementById('new-class-name').value = '';
      document.getElementById('new-class-arms').value = '';
      showToast('Class added.', 'success');
      loadClassesScreen();
    } catch (err) {
      showToast(err.message || 'Could not add class.', 'error');
    } finally {
      hideLoading();
    }
  });

  document.getElementById('add-subject-btn').addEventListener('click', async () => {
    const name = document.getElementById('new-subject-name').value.trim();
    const code = document.getElementById('new-subject-code').value.trim();
    if (!name) { showToast('Enter a subject name.', 'error'); return; }
    showLoading();
    try {
      const { data: subject, error: subjErr } = await supabaseClient
        .from('subjects').insert({ name, code: code || null }).select().single();
      if (subjErr) throw subjErr;

      if (classesWithArmsCache.length > 0) {
        const links = classesWithArmsCache.map(c => ({ class_id: c.id, subject_id: subject.id }));
        const { error: linkErr } = await supabaseClient.from('class_subjects').insert(links);
        if (linkErr) throw linkErr;
      }

      document.getElementById('new-subject-name').value = '';
      document.getElementById('new-subject-code').value = '';
      showToast('Subject added to all classes.', 'success');
      loadClassesScreen();
    } catch (err) {
      showToast(err.message || 'Could not add subject.', 'error');
    } finally {
      hideLoading();
    }
  });
});

/* ----------------------------------------------------------------------------
   15. ADMIN CRUD — STUDENTS
   ---------------------------------------------------------------------------- */
let studentCache = [];
let studentPage = 1;

async function populateStudentClassArmSelects() {
  await refreshClassesWithArmsCache();
  const classSelect = document.getElementById('student-class');
  classSelect.innerHTML = classesWithArmsCache.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
  populateStudentArmSelect(classesWithArmsCache[0] ? classesWithArmsCache[0].id : null);
}

function populateStudentArmSelect(classId) {
  const armSelect = document.getElementById('student-arm');
  const cls = classesWithArmsCache.find(c => c.id === classId);
  armSelect.innerHTML = cls ? cls.arms.map(a => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('') : '';
}

async function loadStudentsScreen() {
  studentPage = 1;
  const tbody = document.getElementById('student-table-body');
  tbody.innerHTML = `<tr class="empty-row"><td colspan="6">Loading…</td></tr>`;

  await populateStudentClassArmSelects();

  const { data: students, error } = await supabaseClient
    .from('students')
    .select('id, admission_number, full_name, gender, parent_id');
  if (error) { showToast(error.message, 'error'); return; }

  const { data: parents } = await supabaseClient.from('parents').select('id, users(full_name)');
  const parentNameById = {};
  (parents || []).forEach(p => { if (p.users) parentNameById[p.id] = p.users.full_name; });

  let enrollmentsQuery = supabaseClient
    .from('enrollments')
    .select('student_id, classes(name), class_arms(name)');
  if (appState.activeTermId) enrollmentsQuery = enrollmentsQuery.eq('term_id', appState.activeTermId);
  const { data: enrollments } = await enrollmentsQuery;
  const enrollmentByStudent = {};
  (enrollments || []).forEach(e => { enrollmentByStudent[e.student_id] = e; });

  studentCache = (students || []).map(s => ({
    id: s.id,
    admission_number: s.admission_number,
    full_name: s.full_name,
    gender: s.gender,
    class_arm: enrollmentByStudent[s.id]
      ? `${enrollmentByStudent[s.id].classes?.name || '—'} ${enrollmentByStudent[s.id].class_arms?.name || ''}`
      : 'Not enrolled this term',
    parent_name: s.parent_id ? (parentNameById[s.parent_id] || '—') : 'Unlinked',
  }));

  renderStudentTable(studentCache);
}

function renderStudentTable(rows) {
  const { pageRows } = paginate(rows, studentPage, 'student-pagination', (p) => { studentPage = p; renderStudentTable(rows); });
  const tbody = document.getElementById('student-table-body');
  if (rows.length === 0) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="6">No students yet — add one above.</td></tr>`;
    return;
  }
  tbody.innerHTML = pageRows.map(r => `
    <tr>
      <td>${escapeHtml(r.admission_number)}</td>
      <td>${escapeHtml(r.full_name)}</td>
      <td>${escapeHtml(r.gender || '—')}</td>
      <td>${escapeHtml(r.class_arm)}</td>
      <td>${escapeHtml(r.parent_name)}</td>
      <td><button type="button" class="icon-btn" data-transfer="${r.id}">Transfer</button></td>
    </tr>
  `).join('');

  tbody.querySelectorAll('[data-transfer]').forEach(btn => {
    btn.addEventListener('click', () => openTransferPrompt(btn.dataset.transfer));
  });
}

async function openTransferPrompt(studentId) {
  if (!appState.activeTermId) { showToast('No active term set.', 'error'); return; }
  await refreshClassesWithArmsCache();
  const options = classesWithArmsCache.flatMap(c => c.arms.map(a => `${c.name} ${a.name} → id:${a.id}`)).join('\n');
  const armId = prompt(`Transfer to which arm? Enter the arm's ID from this list:\n\n${options}`);
  if (!armId) return;
  const targetArm = classesWithArmsCache.flatMap(c => c.arms.map(a => ({ ...a, classId: c.id }))).find(a => a.id === armId.trim());
  if (!targetArm) { showToast('Arm ID not recognized — copy it exactly from the list.', 'error'); return; }

  showLoading();
  try {
    const { data: enrollment, error: fetchErr } = await supabaseClient
      .from('enrollments').select('id, class_id, arm_id').eq('student_id', studentId).eq('term_id', appState.activeTermId).single();
    if (fetchErr) throw fetchErr;

    const { error: transferErr } = await supabaseClient.from('transfers').insert({
      student_id: studentId,
      from_class_id: enrollment.class_id,
      from_arm_id: enrollment.arm_id,
      to_class_id: targetArm.classId,
      to_arm_id: targetArm.id,
      transferred_by: appState.user.id,
    });
    if (transferErr) throw transferErr;

    const { error: updateErr } = await supabaseClient
      .from('enrollments').update({ class_id: targetArm.classId, arm_id: targetArm.id, status: 'transferred' }).eq('id', enrollment.id);
    if (updateErr) throw updateErr;

    showToast('Student transferred.', 'success');
    loadStudentsScreen();
  } catch (err) {
    showToast(err.message || 'Could not transfer student.', 'error');
  } finally {
    hideLoading();
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('student-add-btn').addEventListener('click', () => toggleInlineForm('student-form-card', true));
  document.getElementById('student-form-cancel').addEventListener('click', () => {
    document.getElementById('student-form').reset();
    toggleInlineForm('student-form-card', false);
  });
  document.getElementById('student-search').addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    studentPage = 1;
    renderStudentTable(studentCache.filter(r =>
      r.full_name.toLowerCase().includes(q) || r.admission_number.toLowerCase().includes(q)));
  });
  document.getElementById('student-class').addEventListener('change', (e) => {
    populateStudentArmSelect(e.target.value);
  });

  document.getElementById('student-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('student-form-error');
    errorEl.classList.add('hidden');

    if (!appState.activeSessionId || !appState.activeTermId) {
      errorEl.textContent = 'No active academic session/term is set. Complete the Setup Wizard (or set one in Settings) before enrolling students.';
      errorEl.classList.remove('hidden');
      return;
    }

    showLoading();
    try {
      const parentEmail = document.getElementById('student-parent-email').value.trim();
      let parentId = null;
      if (parentEmail) {
        const { data: parentUser } = await supabaseClient
          .from('users').select('id').eq('email', parentEmail).eq('role', 'parent').maybeSingle();
        if (parentUser) {
          parentId = parentUser.id;
        } else {
          showToast('No parent found with that email — student saved without a linked parent.', 'error');
        }
      }

      const passportFile = document.getElementById('student-passport-file').files[0];
      const passportUrl = await uploadSchoolAsset(passportFile, 'passports');

      const { data: student, error: studentErr } = await supabaseClient
        .from('students')
        .insert({
          admission_number: document.getElementById('student-admission-number').value.trim(),
          full_name: document.getElementById('student-full-name').value.trim(),
          gender: document.getElementById('student-gender').value,
          date_of_birth: document.getElementById('student-dob').value || null,
          passport_url: passportUrl,
          parent_id: parentId,
        })
        .select()
        .single();
      if (studentErr) throw studentErr;

      const { error: enrollErr } = await supabaseClient.from('enrollments').insert({
        student_id: student.id,
        session_id: appState.activeSessionId,
        term_id: appState.activeTermId,
        class_id: document.getElementById('student-class').value,
        arm_id: document.getElementById('student-arm').value,
        status: 'active',
      });
      if (enrollErr) throw enrollErr;

      showToast('Student registered and enrolled.', 'success');
      document.getElementById('student-form').reset();
      toggleInlineForm('student-form-card', false);
      loadStudentsScreen();
    } catch (err) {
      errorEl.textContent = err.message || 'Could not register student.';
      errorEl.classList.remove('hidden');
    } finally {
      hideLoading();
    }
  });
});

/* ----------------------------------------------------------------------------
   16. TEACHER — MY CLASS (roster)
   ---------------------------------------------------------------------------- */
async function getTeacherArms() {
  const { data, error } = await supabaseClient
    .from('class_arms')
    .select('id, name, class_id, classes(name)')
    .eq('class_teacher_id', appState.user.id);
  if (error) { showToast(error.message, 'error'); return []; }
  return data || [];
}

async function loadMyClassScreen() {
  const container = document.getElementById('myclass-content');
  container.innerHTML = '<p class="view-subheading">Loading…</p>';

  const arms = await getTeacherArms();
  if (arms.length === 0) {
    container.innerHTML = `<div class="card card-notice"><p>You have not been assigned to a class arm yet. Ask your administrator to assign you under Classes &amp; Subjects.</p></div>`;
    return;
  }
  if (!appState.activeTermId) {
    container.innerHTML = `<div class="card card-notice"><p>No active academic term is set yet. Ask your administrator to complete setup.</p></div>`;
    return;
  }

  let html = '';
  for (const arm of arms) {
    const { data: enrollments } = await supabaseClient
      .from('enrollments')
      .select('id, students(admission_number, full_name, gender)')
      .eq('arm_id', arm.id)
      .eq('term_id', appState.activeTermId);

    html += `
      <div class="card">
        <h2 class="card-title">${escapeHtml(arm.classes.name)} ${escapeHtml(arm.name)} — ${(enrollments || []).length} student(s)</h2>
        <table class="data-table">
          <thead><tr><th>Adm. No.</th><th>Name</th><th>Gender</th></tr></thead>
          <tbody>
            ${(enrollments || []).length === 0
              ? `<tr class="empty-row"><td colspan="3">No students enrolled this term yet.</td></tr>`
              : enrollments.map(e => `
                <tr>
                  <td>${escapeHtml(e.students.admission_number)}</td>
                  <td>${escapeHtml(e.students.full_name)}</td>
                  <td>${escapeHtml(e.students.gender || '—')}</td>
                </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  }
  container.innerHTML = html;
}

/* ----------------------------------------------------------------------------
   17. TEACHER — RESULTS ENTRY & SUBMISSION
   Enforces, in the UI, the same rules the database already enforces via RLS
   and the state-machine trigger: scores are editable only in draft/rejected,
   submission requires every student to have both scores filled, and only an
   admin can approve/reject (handled in Phase 5).
   ---------------------------------------------------------------------------- */
let resultsScreenState = { armId: null, subjectId: null, termOpen: false };

async function loadResultsScreen() {
  const armSelect = document.getElementById('results-arm-select');
  const subjectSelect = document.getElementById('results-subject-select');
  const notice = document.getElementById('results-entry-notice');
  notice.innerHTML = '';
  document.getElementById('results-entry-table').style.display = 'none';
  document.getElementById('results-submit-row').style.display = 'none';

  const arms = await getTeacherArms();
  if (arms.length === 0) {
    notice.innerHTML = `<div class="card card-notice"><p>You have not been assigned to a class arm yet. Ask your administrator to assign you under Classes &amp; Subjects.</p></div>`;
    armSelect.innerHTML = '';
    subjectSelect.innerHTML = '';
    return;
  }
  armSelect.innerHTML = arms.map(a => `<option value="${a.id}">${escapeHtml(a.classes.name)} ${escapeHtml(a.name)}</option>`).join('');
  resultsScreenState.armId = arms[0].id;

  if (!appState.activeTermId) {
    notice.innerHTML = `<div class="card card-notice"><p>No active academic term is set. Ask your administrator to complete setup.</p></div>`;
    return;
  }

  const { data: term } = await supabaseClient.from('terms').select('is_result_entry_open').eq('id', appState.activeTermId).single();
  resultsScreenState.termOpen = !!(term && term.is_result_entry_open);

  await populateResultsSubjectSelect(resultsScreenState.armId);
  await renderResultsEntryTable();
}

async function populateResultsSubjectSelect(armId) {
  const subjectSelect = document.getElementById('results-subject-select');
  const arm = (await getTeacherArms()).find(a => a.id === armId);
  if (!arm) { subjectSelect.innerHTML = ''; return; }

  const { data: links } = await supabaseClient
    .from('class_subjects')
    .select('subjects(id, name)')
    .eq('class_id', arm.class_id);

  const subjects = (links || []).map(l => l.subjects).filter(Boolean);
  subjectSelect.innerHTML = subjects.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
  resultsScreenState.subjectId = subjects[0] ? subjects[0].id : null;
}

async function renderResultsEntryTable() {
  const notice = document.getElementById('results-entry-notice');
  const table = document.getElementById('results-entry-table');
  const submitRow = document.getElementById('results-submit-row');
  const tbody = document.getElementById('results-entry-body');
  notice.innerHTML = '';

  if (!resultsScreenState.armId || !resultsScreenState.subjectId) {
    table.style.display = 'none';
    submitRow.style.display = 'none';
    return;
  }

  if (!resultsScreenState.termOpen) {
    notice.innerHTML = `<div class="card card-notice"><p>Result entry is currently closed for this term. Ask your administrator to open it.</p></div>`;
    table.style.display = 'none';
    submitRow.style.display = 'none';
    return;
  }

  const { data: enrollments } = await supabaseClient
    .from('enrollments')
    .select('id, student_id, students(full_name)')
    .eq('arm_id', resultsScreenState.armId)
    .eq('term_id', appState.activeTermId);

  if (!enrollments || enrollments.length === 0) {
    notice.innerHTML = `<div class="card card-notice"><p>No students enrolled in this arm for the current term yet.</p></div>`;
    table.style.display = 'none';
    submitRow.style.display = 'none';
    return;
  }

  const { data: existingResults } = await supabaseClient
    .from('results')
    .select('*')
    .eq('subject_id', resultsScreenState.subjectId)
    .eq('term_id', appState.activeTermId)
    .in('enrollment_id', enrollments.map(e => e.id));

  const resultByEnrollment = {};
  (existingResults || []).forEach(r => { resultByEnrollment[r.enrollment_id] = r; });

  table.style.display = '';
  submitRow.style.display = '';

  tbody.innerHTML = enrollments.map(e => {
    const r = resultByEnrollment[e.id];
    const status = r ? r.status : 'draft';
    const editable = status === 'draft';
    const caVal = r ? r.ca_score : '';
    const examVal = r ? r.exam_score : '';
    const totalVal = r ? r.total_score : '—';

    const badgeClass = { draft: 'badge-navy', submitted: 'badge-gold', approved: 'badge-success', rejected: 'badge-error' }[status];
    const badgeLabel = { draft: 'Draft', submitted: 'Submitted', approved: 'Approved', rejected: 'Rejected' }[status];

    return `
      <tr data-enrollment-id="${e.id}" data-student-id="${e.student_id}">
        <td>${escapeHtml(e.students.full_name)}
          ${status === 'rejected' && r.rejection_reason ? `<div class="rejection-note">Rejected: ${escapeHtml(r.rejection_reason)}</div>` : ''}
        </td>
        <td><input class="score-input" type="number" min="0" max="40" data-field="ca" value="${caVal}" ${editable ? '' : 'disabled'}></td>
        <td><input class="score-input" type="number" min="0" max="60" data-field="exam" value="${examVal}" ${editable ? '' : 'disabled'}></td>
        <td class="row-total">${totalVal}</td>
        <td><span class="badge ${badgeClass}">${badgeLabel}</span></td>
        <td>
          ${status === 'rejected' ? `<button type="button" class="icon-btn" data-reopen="${e.id}">Reopen to edit</button>` : ''}
          ${editable ? `<button type="button" class="icon-btn" data-save-row="${e.id}">Save</button>` : ''}
        </td>
      </tr>`;
  }).join('');

  wireResultsRowActions();
}

function wireResultsRowActions() {
  document.querySelectorAll('#results-entry-body tr').forEach(row => {
    const caInput = row.querySelector('[data-field="ca"]');
    const examInput = row.querySelector('[data-field="exam"]');
    const totalCell = row.querySelector('.row-total');
    const recalc = () => {
      const ca = parseFloat(caInput.value) || 0;
      const exam = parseFloat(examInput.value) || 0;
      if (caInput.value !== '' || examInput.value !== '') totalCell.textContent = (ca + exam).toFixed(0) + ' (preview)';
    };
    if (caInput && !caInput.disabled) caInput.addEventListener('input', recalc);
    if (examInput && !examInput.disabled) examInput.addEventListener('input', recalc);
  });

  document.querySelectorAll('[data-save-row]').forEach(btn => {
    btn.addEventListener('click', () => saveResultRow(btn.dataset.saveRow));
  });
  document.querySelectorAll('[data-reopen]').forEach(btn => {
    btn.addEventListener('click', () => reopenResultRow(btn.dataset.reopen));
  });
}

async function saveResultRow(enrollmentId) {
  const row = document.querySelector(`#results-entry-body tr[data-enrollment-id="${enrollmentId}"]`);
  const studentId = row.dataset.studentId;
  const caVal = row.querySelector('[data-field="ca"]').value;
  const examVal = row.querySelector('[data-field="exam"]').value;

  if (caVal === '' || examVal === '') {
    showToast('Enter both CA and Exam scores before saving.', 'error');
    return;
  }
  const ca = Number(caVal), exam = Number(examVal);
  if (ca < 0 || ca > 40 || exam < 0 || exam > 60) {
    showToast('CA must be 0–40 and Exam must be 0–60.', 'error');
    return;
  }

  showLoading();
  try {
    const { error } = await supabaseClient.from('results').upsert({
      enrollment_id: enrollmentId,
      student_id: studentId,
      subject_id: resultsScreenState.subjectId,
      term_id: appState.activeTermId,
      ca_score: ca,
      exam_score: exam,
      status: 'draft',
      entered_by: appState.user.id,
    }, { onConflict: 'enrollment_id,subject_id' });
    if (error) throw error;
    showToast('Saved.', 'success');
    renderResultsEntryTable();
  } catch (err) {
    showToast(err.message || 'Could not save.', 'error');
  } finally {
    hideLoading();
  }
}

async function reopenResultRow(enrollmentId) {
  showLoading();
  try {
    const { error } = await supabaseClient
      .from('results')
      .update({ status: 'draft' })
      .eq('enrollment_id', enrollmentId)
      .eq('subject_id', resultsScreenState.subjectId);
    if (error) throw error;
    showToast('Reopened for editing.', 'success');
    renderResultsEntryTable();
  } catch (err) {
    showToast(err.message || 'Could not reopen.', 'error');
  } finally {
    hideLoading();
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('results-arm-select').addEventListener('change', async (e) => {
    resultsScreenState.armId = e.target.value;
    await populateResultsSubjectSelect(resultsScreenState.armId);
    renderResultsEntryTable();
  });
  document.getElementById('results-subject-select').addEventListener('change', (e) => {
    resultsScreenState.subjectId = e.target.value;
    renderResultsEntryTable();
  });

  document.getElementById('results-submit-btn').addEventListener('click', async () => {
    const draftRows = Array.from(document.querySelectorAll('#results-entry-body tr')).filter(row => {
      const badge = row.querySelector('.badge');
      return badge && badge.textContent.trim() === 'Draft';
    });

    if (draftRows.length === 0) {
      showToast('No draft results to submit for this subject.', 'error');
      return;
    }

    const incomplete = draftRows.filter(row =>
      row.querySelector('[data-field="ca"]').value === '' || row.querySelector('[data-field="exam"]').value === '');
    if (incomplete.length > 0) {
      showToast(`${incomplete.length} student(s) are missing a score. Save every row before submitting.`, 'error');
      return;
    }

    if (!confirm(`Submit ${draftRows.length} result(s) for admin approval? You won't be able to edit them until an admin reviews.`)) return;

    showLoading();
    try {
      const enrollmentIds = draftRows.map(row => row.dataset.enrollmentId);
      const { error } = await supabaseClient
        .from('results')
        .update({ status: 'submitted' })
        .eq('subject_id', resultsScreenState.subjectId)
        .eq('term_id', appState.activeTermId)
        .in('enrollment_id', enrollmentIds)
        .eq('status', 'draft');
      if (error) throw error;
      showToast('Submitted for approval.', 'success');
      renderResultsEntryTable();
    } catch (err) {
      showToast(err.message || 'Could not submit.', 'error');
    } finally {
      hideLoading();
    }
  });
});

/* ----------------------------------------------------------------------------
   18. ADMIN — RESULT APPROVALS
   ---------------------------------------------------------------------------- */
let approvalsState = { armId: null, subjectId: null };

async function loadApprovalsScreen() {
  const container = document.getElementById('approvals-content');
  await refreshClassesWithArmsCache();

  const allArms = classesWithArmsCache.flatMap(c => c.arms.map(a => ({ ...a, className: c.name })));
  if (allArms.length === 0) {
    container.innerHTML = `<div class="card card-notice"><p>No classes/arms exist yet. Add them under Classes &amp; Subjects first.</p></div>`;
    return;
  }
  if (!appState.activeTermId) {
    container.innerHTML = `<div class="card card-notice"><p>No active academic term is set.</p></div>`;
    return;
  }

  approvalsState.armId = approvalsState.armId || allArms[0].id;

  container.innerHTML = `
    <div class="card">
      <div class="form-grid">
        <div>
          <label class="field-label">Class arm</label>
          <select class="field-input" id="approvals-arm-select">
            ${allArms.map(a => `<option value="${a.id}" ${a.id === approvalsState.armId ? 'selected' : ''}>${escapeHtml(a.className)} ${escapeHtml(a.name)}</option>`).join('')}
          </select>
        </div>
        <div>
          <label class="field-label">Subject</label>
          <select class="field-input" id="approvals-subject-select"></select>
        </div>
      </div>
    </div>
    <div id="approvals-table-wrap"></div>
  `;

  document.getElementById('approvals-arm-select').addEventListener('change', async (e) => {
    approvalsState.armId = e.target.value;
    await populateApprovalsSubjectSelect();
    renderApprovalsTable();
  });
  document.getElementById('approvals-subject-select').addEventListener('change', (e) => {
    approvalsState.subjectId = e.target.value;
    renderApprovalsTable();
  });

  await populateApprovalsSubjectSelect();
  renderApprovalsTable();
}

async function populateApprovalsSubjectSelect() {
  const arm = classesWithArmsCache.flatMap(c => c.arms.map(a => ({ ...a, classId: c.id }))).find(a => a.id === approvalsState.armId);
  const select = document.getElementById('approvals-subject-select');
  if (!arm) { select.innerHTML = ''; return; }
  const { data: links } = await supabaseClient
    .from('class_subjects').select('subjects(id, name)').eq('class_id', arm.classId);
  const subjects = (links || []).map(l => l.subjects).filter(Boolean);
  select.innerHTML = subjects.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
  approvalsState.subjectId = subjects[0] ? subjects[0].id : null;
}

async function renderApprovalsTable() {
  const wrap = document.getElementById('approvals-table-wrap');
  if (!approvalsState.armId || !approvalsState.subjectId) { wrap.innerHTML = ''; return; }

  const { data: enrollments } = await supabaseClient
    .from('enrollments')
    .select('id, students(full_name)')
    .eq('arm_id', approvalsState.armId)
    .eq('term_id', appState.activeTermId);

  const { data: results } = await supabaseClient
    .from('results')
    .select('*')
    .eq('subject_id', approvalsState.subjectId)
    .eq('term_id', appState.activeTermId)
    .in('enrollment_id', (enrollments || []).map(e => e.id));

  const submitted = (results || []).filter(r => r.status === 'submitted');
  const otherByEnrollment = {};
  (results || []).forEach(r => { otherByEnrollment[r.enrollment_id] = r; });
  const nameByEnrollment = {};
  (enrollments || []).forEach(e => { nameByEnrollment[e.id] = e.students.full_name; });

  if (submitted.length === 0) {
    wrap.innerHTML = `<div class="card card-notice"><p>No results awaiting approval for this arm/subject right now.</p></div>`;
    return;
  }

  wrap.innerHTML = `
    <div class="table-toolbar"><span></span><button type="button" class="btn btn-primary" id="approve-all-btn">Approve all ${submitted.length} shown</button></div>
    <table class="data-table">
      <thead><tr><th>Student</th><th>CA</th><th>Exam</th><th>Total</th><th>Grade</th><th></th></tr></thead>
      <tbody>
        ${submitted.map(r => `
          <tr data-result-id="${r.id}">
            <td>${escapeHtml(nameByEnrollment[r.enrollment_id] || '—')}</td>
            <td>${r.ca_score}</td>
            <td>${r.exam_score}</td>
            <td>${r.total_score}</td>
            <td>${escapeHtml(r.grade || '—')}</td>
            <td class="row-actions">
              <button type="button" class="icon-btn" data-approve="${r.id}">Approve</button>
              <button type="button" class="icon-btn icon-btn-danger" data-reject="${r.id}">Reject</button>
            </td>
          </tr>`).join('')}
      </tbody>
    </table>
  `;

  wrap.querySelectorAll('[data-approve]').forEach(btn => {
    btn.addEventListener('click', () => approveResult(btn.dataset.approve));
  });
  wrap.querySelectorAll('[data-reject]').forEach(btn => {
    btn.addEventListener('click', () => rejectResult(btn.dataset.reject));
  });
  document.getElementById('approve-all-btn').addEventListener('click', async () => {
    if (!confirm(`Approve all ${submitted.length} submitted result(s) shown?`)) return;
    showLoading();
    try {
      const { error } = await supabaseClient
        .from('results').update({ status: 'approved' })
        .in('id', submitted.map(r => r.id)).eq('status', 'submitted');
      if (error) throw error;
      showToast('All shown results approved.', 'success');
      renderApprovalsTable();
    } catch (err) {
      showToast(err.message || 'Could not approve.', 'error');
    } finally {
      hideLoading();
    }
  });
}

async function approveResult(resultId) {
  showLoading();
  try {
    const { error } = await supabaseClient.from('results').update({ status: 'approved' }).eq('id', resultId);
    if (error) throw error;
    showToast('Approved.', 'success');
    renderApprovalsTable();
  } catch (err) {
    showToast(err.message || 'Could not approve.', 'error');
  } finally {
    hideLoading();
  }
}

async function rejectResult(resultId) {
  const reason = prompt('Reason for rejecting this result (shown to the teacher):');
  if (reason === null) return; // cancelled
  if (!reason.trim()) { showToast('A rejection reason is required.', 'error'); return; }
  showLoading();
  try {
    const { error } = await supabaseClient
      .from('results')
      .update({ status: 'rejected', rejection_reason: reason.trim() })
      .eq('id', resultId);
    if (error) throw error;
    showToast('Rejected and sent back to the teacher.', 'success');
    renderApprovalsTable();
  } catch (err) {
    showToast(err.message || 'Could not reject.', 'error');
  } finally {
    hideLoading();
  }
}

/* ----------------------------------------------------------------------------
   19. REPORT CARDS — generate (derived from approved results) + publish
   Branches by role: admin gets full generate/publish controls; teacher and
   parent get a read-only view scoped by RLS (parents only ever see rows
   with published_at set — enforced by the database, not just this code).
   ---------------------------------------------------------------------------- */
let reportCardsArmId = null;

async function loadReportCardsScreen() {
  const container = document.getElementById('reportcards-content');
  const sub = document.getElementById('reportcards-subheading');

  if (appState.user.role === 'admin') {
    sub.textContent = 'Generated from approved results. Nothing is visible to parents until published.';
    await renderAdminReportCardsScreen(container);
  } else if (appState.user.role === 'teacher') {
    sub.textContent = 'Report card generation and publishing is handled by the administrator.';
    await renderTeacherReportCardsScreen(container);
  } else {
    sub.textContent = 'Published report cards for your child/children.';
    await renderParentReportCardsScreen(container);
  }
}

async function renderAdminReportCardsScreen(container) {
  await refreshClassesWithArmsCache();
  const allArms = classesWithArmsCache.flatMap(c => c.arms.map(a => ({ ...a, className: c.name })));
  if (allArms.length === 0) {
    container.innerHTML = `<div class="card card-notice"><p>No classes/arms exist yet.</p></div>`;
    return;
  }
  if (!appState.activeTermId) {
    container.innerHTML = `<div class="card card-notice"><p>No active academic term is set.</p></div>`;
    return;
  }
  reportCardsArmId = reportCardsArmId || allArms[0].id;

  container.innerHTML = `
    <div class="card">
      <div class="form-grid">
        <div>
          <label class="field-label">Class arm</label>
          <select class="field-input" id="reportcards-arm-select">
            ${allArms.map(a => `<option value="${a.id}" ${a.id === reportCardsArmId ? 'selected' : ''}>${escapeHtml(a.className)} ${escapeHtml(a.name)}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="form-actions">
        <button type="button" class="btn btn-primary" id="generate-reportcards-btn">Generate / refresh report cards for this arm</button>
      </div>
    </div>
    <div id="reportcards-table-wrap"></div>
  `;

  document.getElementById('reportcards-arm-select').addEventListener('change', (e) => {
    reportCardsArmId = e.target.value;
    document.getElementById('reportcards-table-wrap').innerHTML = '';
  });
  document.getElementById('generate-reportcards-btn').addEventListener('click', generateReportCardsForArm);
}

async function generateReportCardsForArm() {
  showLoading();
  try {
    const { data: enrollments } = await supabaseClient
      .from('enrollments')
      .select('id, student_id, students(full_name)')
      .eq('arm_id', reportCardsArmId)
      .eq('term_id', appState.activeTermId);

    const arm = classesWithArmsCache.flatMap(c => c.arms.map(a => ({ ...a, classId: c.id }))).find(a => a.id === reportCardsArmId);
    const { data: classSubjects } = await supabaseClient.from('class_subjects').select('subject_id').eq('class_id', arm.classId);
    const expectedSubjectCount = (classSubjects || []).length;

    const rows = [];
    for (const e of (enrollments || [])) {
      const { data: results } = await supabaseClient
        .from('results').select('total_score, status')
        .eq('enrollment_id', e.id).eq('term_id', appState.activeTermId);
      const approved = (results || []).filter(r => r.status === 'approved');
      const complete = expectedSubjectCount > 0 && approved.length === expectedSubjectCount;
      rows.push({
        enrollment_id: e.id,
        student_id: e.student_id,
        student_name: e.students.full_name,
        approved_count: approved.length,
        expected_count: expectedSubjectCount,
        complete,
        total_score: complete ? approved.reduce((s, r) => s + Number(r.total_score), 0) : null,
      });
    }

    const completeRows = rows.filter(r => r.complete);
    completeRows.forEach(r => { r.average_score = r.total_score / r.expected_count; r.percentage = r.average_score; });
    completeRows.sort((a, b) => b.average_score - a.average_score);
    completeRows.forEach((r, i) => { r.position = i + 1; });

    const highestPct = completeRows.length > 0 ? completeRows[0].percentage : null;
    const lowestPct = completeRows.length > 0 ? completeRows[completeRows.length - 1].percentage : null;

    for (const r of completeRows) {
      const { error } = await supabaseClient.from('report_cards').upsert({
        student_id: r.student_id,
        enrollment_id: r.enrollment_id,
        term_id: appState.activeTermId,
        total_score: r.total_score,
        average_score: r.average_score,
        percentage: r.percentage,
        class_highest_percentage: highestPct,
        class_lowest_percentage: lowestPct,
        position: r.position,
        class_size: rows.length,
        is_annual: false,
        generated_at: new Date().toISOString(),
      }, { onConflict: 'enrollment_id,is_annual' });
      if (error) throw error;
    }

    showToast(`Generated ${completeRows.length} of ${rows.length} report card(s). The rest are missing approved results for one or more subjects.`, completeRows.length > 0 ? 'success' : 'error');
    renderReportCardsTable(rows);
  } catch (err) {
    showToast(err.message || 'Could not generate report cards.', 'error');
  } finally {
    hideLoading();
  }
}

async function renderReportCardsTable(rows) {
  const wrap = document.getElementById('reportcards-table-wrap');
  const { data: existingCards } = await supabaseClient
    .from('report_cards').select('*').eq('term_id', appState.activeTermId).eq('is_annual', false)
    .in('enrollment_id', rows.map(r => r.enrollment_id));
  const cardByEnrollment = {};
  (existingCards || []).forEach(c => { cardByEnrollment[c.enrollment_id] = c; });

  wrap.innerHTML = `
    <table class="data-table">
      <thead><tr><th>Student</th><th>Approved</th><th>Average</th><th>Position</th><th>Status</th><th></th></tr></thead>
      <tbody>
        ${rows.map(r => {
          const card = cardByEnrollment[r.enrollment_id];
          const published = card && card.published_at;
          const confirmed = card && card.teacher_confirmed_at;
          let statusLabel = 'Incomplete', statusBadge = 'badge-error';
          if (card) {
            if (published) { statusLabel = 'Published'; statusBadge = 'badge-success'; }
            else if (confirmed) { statusLabel = 'Confirmed by teacher — ready to publish'; statusBadge = 'badge-gold'; }
            else { statusLabel = 'Awaiting teacher confirmation'; statusBadge = 'badge-navy'; }
          }
          return `
            <tr>
              <td>${escapeHtml(r.student_name)}</td>
              <td>${r.approved_count} / ${r.expected_count}</td>
              <td>${card ? Number(card.average_score).toFixed(1) : '—'}</td>
              <td>${card ? card.position : '—'}</td>
              <td><span class="badge ${statusBadge}">${statusLabel}</span></td>
              <td>${card ? `<button type="button" class="icon-btn" data-preview="${card.id}">Preview</button>` : ''} ${card && !published && confirmed ? `<button type="button" class="icon-btn" data-publish="${card.id}">Publish</button>` : ''}</td>
            </tr>`;
        }).join('')}
      </tbody>
    </table>
  `;

  wrap.querySelectorAll('[data-preview]').forEach(btn => {
    btn.addEventListener('click', () => openReportCardPreview(btn.dataset.preview));
  });

  wrap.querySelectorAll('[data-publish]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Publish this report card? The parent will be able to see it immediately.')) return;
      showLoading();
      try {
        const { error } = await supabaseClient
          .from('report_cards').update({ published_at: new Date().toISOString() }).eq('id', btn.dataset.publish);
        if (error) throw error;
        showToast('Published.', 'success');
        notifyParentReportCardPublished(btn.dataset.publish);
        renderReportCardsTable(rows);
      } catch (err) {
        showToast(err.message || 'Could not publish.', 'error');
      } finally {
        hideLoading();
      }
    });
  });
}

// Emails the linked parent, if any, once a report card becomes visible to
// them. Fire-and-forget — sendAppsScriptEmail() already no-ops safely if no
// webhook is configured yet.
async function notifyParentReportCardPublished(reportCardId) {
  const { data: card } = await supabaseClient.from('report_cards').select('student_id, is_annual').eq('id', reportCardId).single();
  if (!card) return;
  const { data: student } = await supabaseClient.from('students').select('full_name, parent_id').eq('id', card.student_id).single();
  if (!student || !student.parent_id) return;
  const { data: parent } = await supabaseClient.from('parents').select('users(full_name, email)').eq('id', student.parent_id).single();
  if (!parent || !parent.users) return;

  sendAppsScriptEmail({
    type: 'notify',
    to: parent.users.email,
    subject: `${student.full_name}'s ${card.is_annual ? 'annual report' : 'report card'} is ready`,
    body: `Hello ${parent.users.full_name},\n\n${student.full_name}'s ${card.is_annual ? 'annual report' : 'report card'} has been published and is now available to view in the Report Cards section of your account.\n\n— ${appState.schoolSettings?.school_name || 'The school'}`,
  });
}

async function renderTeacherReportCardsScreen(container) {
  const arms = await getTeacherArms();
  if (arms.length === 0 || !appState.activeTermId) {
    container.innerHTML = `<div class="card card-notice"><p>No class arm or active term yet.</p></div>`;
    return;
  }
  const { data: enrollments } = await supabaseClient
    .from('enrollments').select('id, students(full_name)').eq('arm_id', arms[0].id).eq('term_id', appState.activeTermId);
  const { data: cards } = await supabaseClient
    .from('report_cards').select('*').eq('term_id', appState.activeTermId).eq('is_annual', false)
    .in('enrollment_id', (enrollments || []).map(e => e.id));
  const cardByEnrollment = {};
  (cards || []).forEach(c => { cardByEnrollment[c.enrollment_id] = c; });

  const statusFor = (c) => {
    if (!c) return { label: 'Not yet generated', badge: 'badge-error' };
    if (c.published_at) return { label: 'Published', badge: 'badge-success' };
    if (c.teacher_confirmed_at) return { label: 'Confirmed — awaiting publish', badge: 'badge-gold' };
    return { label: 'Awaiting your confirmation', badge: 'badge-navy' };
  };

  container.innerHTML = `
    <table class="data-table">
      <thead><tr><th>Student</th><th>Average</th><th>Position</th><th>Status</th><th></th></tr></thead>
      <tbody>
        ${(enrollments || []).map(e => {
          const c = cardByEnrollment[e.id];
          const status = statusFor(c);
          return `<tr><td>${escapeHtml(e.students.full_name)}</td><td>${c ? Number(c.average_score).toFixed(1) : '—'}</td><td>${c ? c.position : '—'}</td>
            <td><span class="badge ${status.badge}">${status.label}</span></td>
            <td class="row-actions">
              ${c ? `<button type="button" class="icon-btn" data-preview="${c.id}">View</button>` : ''}
              ${c && !c.teacher_confirmed_at && !c.published_at ? `<button type="button" class="icon-btn" data-confirm-card="${c.id}">Confirm for publishing</button>` : ''}
            </td></tr>`;
        }).join('')}
      </tbody>
    </table>
  `;
  container.querySelectorAll('[data-preview]').forEach(btn => {
    btn.addEventListener('click', () => openReportCardPreview(btn.dataset.preview));
  });
  container.querySelectorAll('[data-confirm-card]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Confirm this report card is accurate? The administrator will be able to publish it once you confirm.')) return;
      showLoading();
      try {
        const { error } = await supabaseClient.rpc('confirm_report_card', { card_id: btn.dataset.confirmCard });
        if (error) throw error;
        showToast('Confirmed. The administrator can now publish it.', 'success');
        loadReportCardsScreen();
      } catch (err) {
        showToast(err.message || 'Could not confirm.', 'error');
      } finally {
        hideLoading();
      }
    });
  });
}

async function renderParentReportCardsScreen(container) {
  const { data: children } = await supabaseClient.from('students').select('id, full_name').eq('parent_id', appState.user.id);
  if (!children || children.length === 0) {
    container.innerHTML = `<div class="card card-notice"><p>No children linked to your account yet. Contact the administrator.</p></div>`;
    return;
  }
  const { data: cards } = await supabaseClient
    .from('report_cards')
    .select('*, terms(name)')
    .in('student_id', children.map(c => c.id))
    .not('published_at', 'is', null);

  if (!cards || cards.length === 0) {
    container.innerHTML = `<div class="card card-notice"><p>No published report cards yet. They'll appear here as soon as the school publishes them.</p></div>`;
    return;
  }

  container.innerHTML = cards.map(c => {
    const child = children.find(ch => ch.id === c.student_id);
    return `
      <div class="card">
        <div class="class-card-header">
          <h3>${escapeHtml(child ? child.full_name : 'Student')} — ${escapeHtml(c.terms?.name || 'Term')}${c.is_annual ? ' (Annual)' : ''}</h3>
          <button type="button" class="btn btn-primary" data-preview="${c.id}">View &amp; Print</button>
        </div>
        <dl class="kv-list">
          <div><dt>Average</dt><dd>${Number(c.average_score).toFixed(1)}</dd></div>
          <div><dt>Position</dt><dd>${c.position} of ${c.class_size}</dd></div>
        </dl>
      </div>`;
  }).join('');

  container.querySelectorAll('[data-preview]').forEach(btn => {
    btn.addEventListener('click', () => openReportCardPreview(btn.dataset.preview));
  });
}

/* ----------------------------------------------------------------------------
   20. REPORT CARD PREVIEW / PRINT (Phase 6)
   Shared overlay used by admin (preview + edit comments + publish before
   parents can see it), teacher (view their class's cards), and parent
   (view + print/save-as-PDF published cards). window.print() + the print
   stylesheet in styles.css does the PDF export — no extra library needed.
   ---------------------------------------------------------------------------- */
let currentPreviewCardId = null;

async function openReportCardPreview(reportCardId) {
  showLoading();
  try {
    const data = await fetchFullReportCardData(reportCardId);
    currentPreviewCardId = reportCardId;
    document.getElementById('report-card-print-area').innerHTML = renderReportCardHTML(data);

    const adminPanel = document.getElementById('report-card-admin-panel');
    const publishBtn = document.getElementById('rc-publish-btn');
    if (appState.user.role === 'admin' && !data.card.published_at) {
      document.getElementById('rc-general-conduct').value = data.card.general_conduct || '';
      document.getElementById('rc-teacher-comment').value = data.card.class_teacher_comment || '';
      document.getElementById('rc-head-comment').value = data.card.head_teacher_comment || '';
      document.getElementById('rc-next-term-begins').value = data.card.next_term_begins || '';
      document.getElementById('rc-next-term-fees').value = data.card.next_term_fees || '';
      adminPanel.classList.remove('hidden');

      if (data.card.teacher_confirmed_at) {
        publishBtn.disabled = false;
        publishBtn.textContent = 'Publish this report card';
      } else {
        publishBtn.disabled = true;
        publishBtn.textContent = 'Waiting on class teacher to confirm first';
      }
    } else {
      adminPanel.classList.add('hidden');
    }

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
}

// TERM_ORDER lets us know which terms come "at or before" the term being
// printed, so a First Term card never shows Second/Third Term data (it
// wouldn't exist yet at that point in the year) while a Third Term card
// naturally shows all three — which is what makes it double as the annual
// view, per the school's actual printed template.
const TERM_ORDER = ['First Term', 'Second Term', 'Third Term'];

async function fetchFullReportCardData(reportCardId) {
  const { data: card, error } = await supabaseClient.from('report_cards').select('*').eq('id', reportCardId).single();
  if (error) throw error;

  const { data: enrollment } = await supabaseClient
    .from('enrollments')
    .select('id, class_id, session_id, classes(name), class_arms(name, class_teacher_id), sessions(name), terms(name)')
    .eq('id', card.enrollment_id).single();

  const { data: student } = await supabaseClient
    .from('students').select('full_name, admission_number, gender, passport_url').eq('id', card.student_id).single();

  let teacherName = '—';
  if (enrollment?.class_arms?.class_teacher_id) {
    const { data: teacherStaff } = await supabaseClient
      .from('staff').select('users(full_name)').eq('id', enrollment.class_arms.class_teacher_id).single();
    teacherName = teacherStaff?.users?.full_name || '—';
  }

  // Every subject the class is meant to study, so a subject with no
  // approved result yet for a given term still gets a blank row/cell
  // rather than disappearing entirely.
  const { data: classSubjectLinks } = await supabaseClient
    .from('class_subjects').select('subjects(id, name)').eq('class_id', enrollment.class_id);
  const allSubjects = (classSubjectLinks || []).map(l => l.subjects).filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));

  // All terms in this session at or before the current card's own term.
  const currentTermIndex = TERM_ORDER.indexOf(enrollment.terms.name);
  const includedTermNames = TERM_ORDER.slice(0, currentTermIndex + 1);
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
  // has data for that subject (per the school's own template design).
  const subjectRows = allSubjects.map(subj => {
    const terms = includedTermNames.map(termName => resultsByTermAndSubject[termName][subj.id] || null);
    const latest = [...terms].reverse().find(t => t) || null;
    return {
      subjectName: subj.name,
      terms, // aligned with includedTermNames
      grade: latest ? latest.grade : null,
      remark: latest ? latest.remark : null,
    };
  });

  return {
    card, student, enrollment, teacherName,
    includedTermNames, subjectRows,
    school: appState.schoolSettings,
  };
}

function renderReportCardHTML(data) {
  const { card, student, enrollment, teacherName, includedTermNames, subjectRows, school } = data;
  const watermark = school?.report_watermark_url
    ? `<div class="rc-watermark"><img src="${school.report_watermark_url}" alt=""></div>` : '';
  const logo = school?.logo_url ? `<img class="rc-logo" src="${school.logo_url}" alt="School logo">` : '';
  const passport = student.passport_url
    ? `<img class="rc-passport" src="${student.passport_url}" alt="Passport photo">`
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
    return `
      <tr>
        <td>${escapeHtml(row.subjectName)}</td>
        ${termCells}
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
        <div><span>Class</span><span>${escapeHtml(enrollment.classes.name)} ${escapeHtml(enrollment.class_arms.name)}</span></div>
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
          <tr><th rowspan="2">Subject</th>${groupHeaderCells}<th rowspan="2">Grade</th><th rowspan="2">Teacher's Remark</th></tr>
          <tr>${subHeaderCells}</tr>
        </thead>
        <tbody>
          <tr class="rc-mark-obtainable"><td>Mark Obtainable</td>${markObtainableCells}<td></td><td></td></tr>
          ${subjectBodyRows || `<tr><td colspan="${2 + includedTermNames.length * 3}" style="text-align:center;color:var(--color-slate);">No approved subject results yet.</td></tr>`}
        </tbody>
      </table>
    </div>

    ${enrollment.terms.name === 'Third Term' && card.annual_average != null ? `
      <div class="rc-summary" style="grid-template-columns: repeat(2, 1fr);">
        <div class="rc-summary-box"><div class="label">Annual Average</div><div class="value">${Number(card.annual_average).toFixed(1)}%</div></div>
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

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('close-report-card-btn').addEventListener('click', closeReportCardPreview);
  document.getElementById('print-report-card-btn').addEventListener('click', () => window.print());

  document.getElementById('rc-save-comments-btn').addEventListener('click', async () => {
    if (!currentPreviewCardId) return;
    showLoading();
    try {
      const { error } = await supabaseClient.from('report_cards').update({
        general_conduct: document.getElementById('rc-general-conduct').value.trim(),
        class_teacher_comment: document.getElementById('rc-teacher-comment').value.trim(),
        head_teacher_comment: document.getElementById('rc-head-comment').value.trim(),
        next_term_begins: document.getElementById('rc-next-term-begins').value || null,
        next_term_fees: document.getElementById('rc-next-term-fees').value.trim(),
      }).eq('id', currentPreviewCardId);
      if (error) throw error;
      showToast('Comments saved.', 'success');
      const data = await fetchFullReportCardData(currentPreviewCardId);
      document.getElementById('report-card-print-area').innerHTML = renderReportCardHTML(data);
    } catch (err) {
      showToast(err.message || 'Could not save comments.', 'error');
    } finally {
      hideLoading();
    }
  });

  document.getElementById('rc-publish-btn').addEventListener('click', async () => {
    if (!currentPreviewCardId) return;
    if (!confirm('Publish this report card? The parent will be able to see and print it immediately.')) return;
    showLoading();
    try {
      const { error } = await supabaseClient
        .from('report_cards').update({ published_at: new Date().toISOString() }).eq('id', currentPreviewCardId);
      if (error) throw error;
      showToast('Published.', 'success');
      notifyParentReportCardPublished(currentPreviewCardId);
      closeReportCardPreview();
      loadReportCardsScreen();
    } catch (err) {
      showToast(err.message || 'Could not publish.', 'error');
    } finally {
      hideLoading();
    }
  });
});

/* ----------------------------------------------------------------------------
   21. PROMOTIONS & ANNUAL REPORTS (Phase 7)
   Annual Average = (T1 avg + T2 avg + T3 avg) / 3, computed only when all
   three term report cards exist for a student. The annual report_cards row
   is anchored to the student's Third Term enrollment (report_cards.enrollment
   _id is inherently per-term; there is no separate per-session enrollment
   row, so the Third Term's is the natural anchor for "the whole session").
   Recommended promotion is threshold-based; the admin's actual decision is
   recorded separately in promotions and only then reflected back onto the
   report card's promotion_status.
   ---------------------------------------------------------------------------- */
let promotionsArmId = null;

async function loadPromotionsScreen() {
  const container = document.getElementById('promotions-content');
  await refreshClassesWithArmsCache();
  const allArms = classesWithArmsCache.flatMap(c => c.arms.map(a => ({ ...a, className: c.name, classId: c.id })));

  if (allArms.length === 0) {
    container.innerHTML = `<div class="card card-notice"><p>No classes/arms exist yet.</p></div>`;
    return;
  }
  if (!appState.activeSessionId) {
    container.innerHTML = `<div class="card card-notice"><p>No active academic session is set.</p></div>`;
    return;
  }

  const { data: thirdTerm } = await supabaseClient
    .from('terms').select('id, is_current').eq('session_id', appState.activeSessionId).eq('name', 'Third Term').maybeSingle();
  if (!thirdTerm) {
    container.innerHTML = `<div class="card card-notice"><p>This session has no Third Term yet.</p></div>`;
    return;
  }

  promotionsArmId = promotionsArmId || allArms[0].id;

  container.innerHTML = `
    <div class="card">
      <div class="form-grid">
        <div>
          <label class="field-label">Class arm</label>
          <select class="field-input" id="promotions-arm-select">
            ${allArms.map(a => `<option value="${a.id}" ${a.id === promotionsArmId ? 'selected' : ''}>${escapeHtml(a.className)} ${escapeHtml(a.name)}</option>`).join('')}
          </select>
        </div>
        <div>
          <label class="field-label">Promotion threshold (annual average ≥)</label>
          <input class="field-input" type="number" id="promotion-threshold-input" value="${appState.schoolSettings?.promotion_average_threshold ?? 40}">
        </div>
      </div>
      <div class="form-actions">
        <button type="button" class="btn btn-ghost-dark" id="save-threshold-btn">Save threshold</button>
        <button type="button" class="btn btn-primary" id="generate-annual-btn">Calculate annual averages for this arm</button>
      </div>
    </div>
    <div id="promotions-table-wrap"></div>
  `;

  document.getElementById('promotions-arm-select').addEventListener('change', (e) => {
    promotionsArmId = e.target.value;
    document.getElementById('promotions-table-wrap').innerHTML = '';
  });

  document.getElementById('save-threshold-btn').addEventListener('click', async () => {
    const val = Number(document.getElementById('promotion-threshold-input').value);
    if (Number.isNaN(val)) { showToast('Enter a valid number.', 'error'); return; }
    const { data, error } = await supabaseClient
      .from('school_settings').update({ promotion_average_threshold: val }).eq('id', true).select().single();
    if (error) { showToast(error.message, 'error'); return; }
    setState({ schoolSettings: data });
    showToast('Threshold saved.', 'success');
  });

  document.getElementById('generate-annual-btn').addEventListener('click', () => generateAnnualReportsForArm(thirdTerm.id, allArms));
}

async function generateAnnualReportsForArm(thirdTermId, allArms) {
  showLoading();
  try {
    const arm = allArms.find(a => a.id === promotionsArmId);
    const threshold = Number(appState.schoolSettings?.promotion_average_threshold ?? 40);

    const { data: thirdTermEnrollments } = await supabaseClient
      .from('enrollments')
      .select('id, student_id, students(full_name)')
      .eq('arm_id', promotionsArmId)
      .eq('term_id', thirdTermId);

    const rows = [];
    for (const e of (thirdTermEnrollments || [])) {
      const { data: thirdTermCard } = await supabaseClient
        .from('report_cards').select('id').eq('enrollment_id', e.id).eq('is_annual', false).maybeSingle();

      const { data: studentEnrollments } = await supabaseClient
        .from('enrollments').select('id, term_id').eq('student_id', e.student_id).eq('session_id', appState.activeSessionId);
      const { data: termCards } = await supabaseClient
        .from('report_cards').select('enrollment_id, percentage').eq('is_annual', false)
        .in('enrollment_id', (studentEnrollments || []).map(se => se.id));

      const percentages = (termCards || []).map(c => Number(c.percentage)).filter(v => !Number.isNaN(v));
      // "Complete" here means all 3 terms have a generated report card with a
      // percentage AND this Third Term card specifically already exists —
      // annual reporting piggybacks on the Third Term card the admin already
      // generated from the normal Report Cards screen, rather than creating
      // a separate row.
      const complete = (studentEnrollments || []).length >= 3 && percentages.length >= 3 && !!thirdTermCard;
      const annualAverage = complete ? percentages.reduce((s, v) => s + v, 0) / percentages.length : null;

      rows.push({
        thirdTermCardId: thirdTermCard ? thirdTermCard.id : null,
        studentId: e.student_id,
        studentName: e.students.full_name,
        complete,
        annualAverage,
        recommended: complete ? (annualAverage >= threshold ? 'promote' : 'repeat') : null,
      });
    }

    const completeRows = rows.filter(r => r.complete);

    for (const r of completeRows) {
      const { error: cardErr } = await supabaseClient.from('report_cards')
        .update({ annual_average: r.annualAverage, promotion_status: 'pending' })
        .eq('id', r.thirdTermCardId);
      if (cardErr) throw cardErr;

      const { error: promoErr } = await supabaseClient.from('promotions').upsert({
        student_id: r.studentId,
        session_id: appState.activeSessionId,
        from_class_id: arm.classId,
        recommended_status: r.recommended,
        final_status: 'pending',
      }, { onConflict: 'student_id,session_id' });
      if (promoErr) throw promoErr;
    }

    const missingThirdTermCard = rows.filter(r => !r.thirdTermCardId).length;
    showToast(
      `Updated ${completeRows.length} of ${rows.length} annual figure(s).` +
      (missingThirdTermCard > 0 ? ` ${missingThirdTermCard} still need their Third Term report card generated first (Report Cards screen).` : ''),
      completeRows.length > 0 ? 'success' : 'error'
    );
    renderPromotionsTable(rows, arm, allArms);
  } catch (err) {
    showToast(err.message || 'Could not update annual figures.', 'error');
  } finally {
    hideLoading();
  }
}

async function renderPromotionsTable(rows, arm, allArms) {
  const wrap = document.getElementById('promotions-table-wrap');

  const cardIds = rows.map(r => r.thirdTermCardId).filter(Boolean);
  const { data: cards } = await supabaseClient.from('report_cards').select('*').in('id', cardIds);
  const { data: promos } = await supabaseClient
    .from('promotions').select('*').eq('session_id', appState.activeSessionId)
    .in('student_id', rows.map(r => r.studentId));

  wrap.innerHTML = `
    <table class="data-table">
      <thead><tr><th>Student</th><th>Annual Avg</th><th>Recommended</th><th>Decision</th><th></th></tr></thead>
      <tbody>
        ${rows.map(r => {
          const card = (cards || []).find(c => c.id === r.thirdTermCardId);
          const promo = (promos || []).find(p => p.student_id === r.studentId);
          const decided = promo && promo.final_status !== 'pending';
          return `
            <tr>
              <td>${escapeHtml(r.studentName)}${!r.complete ? ' <span class="badge badge-error">Incomplete</span>' : ''}</td>
              <td>${card && card.annual_average != null ? Number(card.annual_average).toFixed(1) : '—'}</td>
              <td>${promo ? `<span class="badge ${promo.recommended_status === 'promote' ? 'badge-success' : 'badge-gold'}">${promo.recommended_status === 'promote' ? 'Promote' : 'Repeat'}</span>` : '—'}</td>
              <td>${decided ? `<span class="badge ${promo.final_status === 'promoted' ? 'badge-success' : 'badge-gold'}">${promo.final_status === 'promoted' ? 'Promoted' : 'Repeating'}</span>` : (promo ? '<span class="badge badge-navy">Pending decision</span>' : '—')}</td>
              <td class="row-actions">
                ${card ? `<button type="button" class="icon-btn" data-preview="${card.id}">Preview</button>` : ''}
                ${promo && !decided ? `
                  <button type="button" class="icon-btn" data-approve-promo="${promo.id}" data-card="${card ? card.id : ''}" data-class="${arm.classId}">Approve promotion</button>
                  <button type="button" class="icon-btn icon-btn-danger" data-repeat-promo="${promo.id}" data-card="${card ? card.id : ''}" data-class="${arm.classId}">Mark repeat</button>` : ''}
              </td>
            </tr>`;
        }).join('')}
      </tbody>
    </table>
  `;

  wrap.querySelectorAll('[data-preview]').forEach(btn => {
    btn.addEventListener('click', () => openReportCardPreview(btn.dataset.preview));
  });
  wrap.querySelectorAll('[data-approve-promo]').forEach(btn => {
    btn.addEventListener('click', () => decidePromotion(btn.dataset.approvePromo, btn.dataset.card, btn.dataset.class, 'promoted', allArms));
  });
  wrap.querySelectorAll('[data-repeat-promo]').forEach(btn => {
    btn.addEventListener('click', () => decidePromotion(btn.dataset.repeatPromo, btn.dataset.card, btn.dataset.class, 'repeated', allArms));
  });
}

async function decidePromotion(promotionId, cardId, currentClassId, decision, allArms) {
  if (!confirm(`Confirm: mark this student as "${decision}"?`)) return;
  showLoading();
  try {
    let toClassId = currentClassId;
    let newEnrollmentStatus = null;

    if (decision === 'promoted') {
      const currentClass = classesWithArmsCache.find(c => c.id === currentClassId);
      const nextClass = classesWithArmsCache
        .filter(c => c.sort_order > (currentClass ? currentClass.sort_order : -1))
        .sort((a, b) => a.sort_order - b.sort_order)[0];
      if (nextClass) {
        toClassId = nextClass.id;
      } else {
        toClassId = currentClassId;
        newEnrollmentStatus = 'graduated';
      }
    }

    const { error: promoErr } = await supabaseClient.from('promotions').update({
      final_status: decision,
      to_class_id: toClassId,
      decided_by: appState.user.id,
      decided_at: new Date().toISOString(),
    }).eq('id', promotionId);
    if (promoErr) throw promoErr;

    if (cardId) {
      const { error: cardErr } = await supabaseClient.from('report_cards')
        .update({ promotion_status: decision }).eq('id', cardId);
      if (cardErr) throw cardErr;
    }

    if (newEnrollmentStatus) {
      const { data: promoRow } = await supabaseClient.from('promotions').select('student_id').eq('id', promotionId).single();
      if (promoRow) {
        await supabaseClient.from('students').update({ enrollment_status: newEnrollmentStatus }).eq('id', promoRow.student_id);
      }
    }

    showToast(`Marked ${decision}.`, 'success');
    loadPromotionsScreen();
  } catch (err) {
    showToast(err.message || 'Could not save decision.', 'error');
  } finally {
    hideLoading();
  }
}

/* ----------------------------------------------------------------------------
   22. DASHBOARD ANALYTICS (Admin) — Phase 8
   Small hand-rolled SVG bar charts, since the stack is vanilla JS only and
   pulling in a charting library for two bar charts isn't worth the weight.
   ---------------------------------------------------------------------------- */
function renderBarChartSVG(data, { width = 320, height = 160, color = 'var(--color-navy)' } = {}) {
  if (data.length === 0) return `<p class="view-subheading">No data yet.</p>`;
  const max = Math.max(...data.map(d => d.value), 1);
  const barWidth = width / data.length;
  const bars = data.map((d, i) => {
    const barHeight = (d.value / max) * (height - 30);
    const x = i * barWidth + barWidth * 0.15;
    const w = barWidth * 0.7;
    const y = height - 20 - barHeight;
    return `
      <rect x="${x}" y="${y}" width="${w}" height="${barHeight}" fill="${color}" rx="2"></rect>
      <text x="${x + w / 2}" y="${height - 6}" text-anchor="middle" font-size="10" fill="var(--color-slate)">${escapeHtml(d.label)}</text>
      <text x="${x + w / 2}" y="${y - 4}" text-anchor="middle" font-size="10" fill="var(--color-ink)">${d.value}</text>
    `;
  }).join('');
  return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}">${bars}</svg>`;
}

async function loadDashboardAnalytics() {
  const container = document.getElementById('dashboard-analytics');
  if (appState.user.role !== 'admin') { container.innerHTML = ''; return; }

  const count = async (table, filters = {}) => {
    let q = supabaseClient.from(table).select('*', { count: 'exact', head: true });
    Object.entries(filters).forEach(([k, v]) => { q = q.eq(k, v); });
    const { count: c } = await q;
    return c || 0;
  };

  const [totalStudents, totalStaff, totalParents, totalClasses, totalSubjects, pendingApprovals, publishedCards] = await Promise.all([
    count('students'),
    count('staff'),
    count('parents'),
    count('classes'),
    count('subjects'),
    appState.activeTermId ? count('results', { term_id: appState.activeTermId, status: 'submitted' }) : 0,
    appState.activeTermId ? count('report_cards', { term_id: appState.activeTermId, is_annual: false }) : 0,
  ]);

  let sessionName = '—', termName = '—';
  if (appState.activeSessionId) {
    const { data } = await supabaseClient.from('sessions').select('name').eq('id', appState.activeSessionId).single();
    sessionName = data?.name || '—';
  }
  if (appState.activeTermId) {
    const { data } = await supabaseClient.from('terms').select('name').eq('id', appState.activeTermId).single();
    termName = data?.name || '—';
  }

  // Enrollment by class (active term)
  let enrollmentChart = '<p class="view-subheading">No active term.</p>';
  if (appState.activeTermId) {
    const { data: enrollments } = await supabaseClient
      .from('enrollments').select('class_id, classes(name)').eq('term_id', appState.activeTermId);
    const byClass = {};
    (enrollments || []).forEach(e => {
      const name = e.classes?.name || 'Unknown';
      byClass[name] = (byClass[name] || 0) + 1;
    });
    enrollmentChart = renderBarChartSVG(Object.entries(byClass).map(([label, value]) => ({ label, value })), { color: 'var(--color-navy)' });
  }

  // Grade distribution A-F (approved results, active term)
  let gradeChart = '<p class="view-subheading">No active term.</p>';
  if (appState.activeTermId) {
    const { data: results } = await supabaseClient
      .from('results').select('grade').eq('term_id', appState.activeTermId).eq('status', 'approved');
    const byGrade = {};
    (results || []).forEach(r => { byGrade[r.grade] = (byGrade[r.grade] || 0) + 1; });
    const order = ['A', 'B', 'C', 'D', 'E', 'F'];
    const chartData = order.filter(g => byGrade[g]).map(g => ({ label: g, value: byGrade[g] }));
    gradeChart = renderBarChartSVG(chartData, { color: 'var(--color-gold)' });
  }

  // Recent activity from audit_log
  const { data: recent } = await supabaseClient
    .from('audit_log').select('*, users(full_name)').order('created_at', { ascending: false }).limit(8);

  container.innerHTML = `
    <div class="dashboard-stat-grid">
      ${[
        ['Students', totalStudents], ['Staff', totalStaff], ['Parents', totalParents],
        ['Classes', totalClasses], ['Subjects', totalSubjects],
        ['Pending approvals', pendingApprovals], ['Published report cards', publishedCards],
      ].map(([label, value]) => `
        <div class="dashboard-stat-card">
          <div class="dashboard-stat-value">${value}</div>
          <div class="dashboard-stat-label">${escapeHtml(label)}</div>
        </div>`).join('')}
      <div class="dashboard-stat-card">
        <div class="dashboard-stat-value" style="font-size:16px;">${escapeHtml(sessionName)}</div>
        <div class="dashboard-stat-label">${escapeHtml(termName)}</div>
      </div>
    </div>

    <div class="dashboard-chart-grid">
      <div class="card"><h2 class="card-title">Enrollment by class</h2>${enrollmentChart}</div>
      <div class="card"><h2 class="card-title">Grade distribution (approved results)</h2>${gradeChart}</div>
    </div>

    <div class="card">
      <h2 class="card-title">Recent activity</h2>
      ${(recent || []).length === 0 ? '<p class="view-subheading">Nothing recorded yet.</p>' : `
        <table class="data-table">
          <thead><tr><th>When</th><th>User</th><th>Action</th><th>Table</th></tr></thead>
          <tbody>
            ${recent.map(r => `
              <tr>
                <td>${new Date(r.created_at).toLocaleString()}</td>
                <td>${escapeHtml(r.users?.full_name || 'System')}</td>
                <td>${escapeHtml(r.action_type)}</td>
                <td>${escapeHtml(r.table_name)}</td>
              </tr>`).join('')}
          </tbody>
        </table>`}
    </div>
  `;
}

/* ----------------------------------------------------------------------------
   23. ATTENDANCE (Phase 8)
   Teacher: daily entry for their arm, with auto-computed term totals.
   Admin: pick any arm, view the same totals (read-only).
   Parent: their child's own totals for the active term.
   ---------------------------------------------------------------------------- */
let attendanceArmId = null;

async function loadAttendanceScreen() {
  const container = document.getElementById('attendance-content');
  const sub = document.getElementById('attendance-subheading');

  if (appState.user.role === 'teacher') {
    sub.textContent = 'Mark today\'s attendance for your class. Totals update automatically.';
    await renderTeacherAttendanceScreen(container);
  } else if (appState.user.role === 'admin') {
    sub.textContent = 'Read-only view of attendance totals per class arm.';
    await renderAdminAttendanceScreen(container);
  } else {
    sub.textContent = 'Your child\'s attendance for the active term.';
    await renderParentAttendanceScreen(container);
  }
}

async function renderTeacherAttendanceScreen(container) {
  const arms = await getTeacherArms();
  if (arms.length === 0 || !appState.activeTermId) {
    container.innerHTML = `<div class="card card-notice"><p>No class arm or active term yet.</p></div>`;
    return;
  }
  const arm = arms[0];
  const today = new Date().toISOString().slice(0, 10);

  const { data: enrollments } = await supabaseClient
    .from('enrollments').select('id, student_id, students(full_name)').eq('arm_id', arm.id).eq('term_id', appState.activeTermId);

  const { data: todayRecords } = await supabaseClient
    .from('attendance').select('*').eq('date', today).in('enrollment_id', (enrollments || []).map(e => e.id));
  const byEnrollment = {};
  (todayRecords || []).forEach(r => { byEnrollment[r.enrollment_id] = r.status; });

  container.innerHTML = `
    <div class="card">
      <h2 class="card-title">${escapeHtml(arm.classes.name)} ${escapeHtml(arm.name)} — ${today}</h2>
      <table class="data-table">
        <thead><tr><th>Student</th><th>Present</th><th>Absent</th></tr></thead>
        <tbody>
          ${(enrollments || []).map(e => `
            <tr data-enrollment-id="${e.id}" data-student-id="${e.student_id}">
              <td>${escapeHtml(e.students.full_name)}</td>
              <td><input type="radio" name="att-${e.id}" value="present" ${byEnrollment[e.id] === 'present' ? 'checked' : ''}></td>
              <td><input type="radio" name="att-${e.id}" value="absent" ${byEnrollment[e.id] === 'absent' ? 'checked' : ''}></td>
            </tr>`).join('')}
        </tbody>
      </table>
      <div class="form-actions"><button type="button" class="btn btn-primary" id="save-attendance-btn">Save today's attendance</button></div>
    </div>
    <div class="card">
      <h2 class="card-title">Term totals so far</h2>
      <div id="attendance-totals"></div>
    </div>
  `;

  document.getElementById('save-attendance-btn').addEventListener('click', async () => {
    showLoading();
    try {
      const rows = Array.from(container.querySelectorAll('tbody tr')).map(row => {
        const checked = row.querySelector('input:checked');
        return checked ? {
          enrollment_id: row.dataset.enrollmentId,
          student_id: row.dataset.studentId,
          date: today,
          status: checked.value,
          recorded_by: appState.user.id,
        } : null;
      }).filter(Boolean);

      if (rows.length === 0) { showToast('Mark at least one student before saving.', 'error'); hideLoading(); return; }

      const { error } = await supabaseClient.from('attendance').upsert(rows, { onConflict: 'enrollment_id,date' });
      if (error) throw error;
      showToast('Attendance saved.', 'success');
      renderAttendanceTotals(enrollments, arm.id);
    } catch (err) {
      showToast(err.message || 'Could not save attendance.', 'error');
    } finally {
      hideLoading();
    }
  });

  renderAttendanceTotals(enrollments, arm.id);
}

async function renderAttendanceTotals(enrollments, armId) {
  const wrap = document.getElementById('attendance-totals');
  if (!wrap) return;
  const { data: allRecords } = await supabaseClient
    .from('attendance').select('enrollment_id, status').in('enrollment_id', (enrollments || []).map(e => e.id));

  wrap.innerHTML = `
    <table class="data-table">
      <thead><tr><th>Student</th><th>Present</th><th>Absent</th><th>%</th></tr></thead>
      <tbody>
        ${(enrollments || []).map(e => {
          const records = (allRecords || []).filter(r => r.enrollment_id === e.id);
          const present = records.filter(r => r.status === 'present').length;
          const total = records.length;
          const pct = total > 0 ? Math.round((present / total) * 100) : 0;
          return `<tr><td>${escapeHtml(e.students.full_name)}</td><td>${present}</td><td>${total - present}</td><td>${pct}%</td></tr>`;
        }).join('')}
      </tbody>
    </table>
  `;
}

async function renderAdminAttendanceScreen(container) {
  await refreshClassesWithArmsCache();
  const allArms = classesWithArmsCache.flatMap(c => c.arms.map(a => ({ ...a, className: c.name })));
  if (allArms.length === 0 || !appState.activeTermId) {
    container.innerHTML = `<div class="card card-notice"><p>No classes or active term yet.</p></div>`;
    return;
  }
  attendanceArmId = attendanceArmId || allArms[0].id;

  container.innerHTML = `
    <div class="card">
      <label class="field-label">Class arm</label>
      <select class="field-input" id="attendance-admin-arm-select">
        ${allArms.map(a => `<option value="${a.id}" ${a.id === attendanceArmId ? 'selected' : ''}>${escapeHtml(a.className)} ${escapeHtml(a.name)}</option>`).join('')}
      </select>
    </div>
    <div id="attendance-totals"></div>
  `;

  const loadForArm = async () => {
    const { data: enrollments } = await supabaseClient
      .from('enrollments').select('id, students(full_name)').eq('arm_id', attendanceArmId).eq('term_id', appState.activeTermId);
    renderAttendanceTotals(enrollments, attendanceArmId);
  };
  document.getElementById('attendance-admin-arm-select').addEventListener('change', (e) => { attendanceArmId = e.target.value; loadForArm(); });
  loadForArm();
}

async function renderParentAttendanceScreen(container) {
  const { data: children } = await supabaseClient.from('students').select('id, full_name').eq('parent_id', appState.user.id);
  if (!children || children.length === 0 || !appState.activeTermId) {
    container.innerHTML = `<div class="card card-notice"><p>No children linked yet, or no active term.</p></div>`;
    return;
  }
  let html = '';
  for (const child of children) {
    const { data: enrollment } = await supabaseClient
      .from('enrollments').select('id').eq('student_id', child.id).eq('term_id', appState.activeTermId).maybeSingle();
    if (!enrollment) { html += `<div class="card"><h2 class="card-title">${escapeHtml(child.full_name)}</h2><p class="view-subheading">Not enrolled this term.</p></div>`; continue; }
    const { data: records } = await supabaseClient.from('attendance').select('status').eq('enrollment_id', enrollment.id);
    const present = (records || []).filter(r => r.status === 'present').length;
    const total = (records || []).length;
    const pct = total > 0 ? Math.round((present / total) * 100) : 0;
    html += `
      <div class="card">
        <h2 class="card-title">${escapeHtml(child.full_name)}</h2>
        <dl class="kv-list">
          <div><dt>Present</dt><dd>${present}</dd></div>
          <div><dt>Absent</dt><dd>${total - present}</dd></div>
          <div><dt>Attendance rate</dt><dd>${pct}%</dd></div>
        </dl>
      </div>`;
  }
  container.innerHTML = html;
}

/* ----------------------------------------------------------------------------
   24. ANNOUNCEMENTS (Phase 8)
   ---------------------------------------------------------------------------- */
async function loadAnnouncementsScreen() {
  const container = document.getElementById('announcements-content');
  const sub = document.getElementById('announcements-subheading');

  if (appState.user.role === 'admin') {
    sub.textContent = 'Create and publish announcements. Unpublished drafts are visible only to you.';
    await renderAdminAnnouncementsScreen(container);
  } else {
    sub.textContent = 'Published announcements for you.';
    await renderReadOnlyAnnouncementsScreen(container);
  }
}

async function renderAdminAnnouncementsScreen(container) {
  const { data: announcements } = await supabaseClient.from('announcements').select('*').order('created_at', { ascending: false });

  container.innerHTML = `
    <div class="inline-form-card">
      <h3>New announcement</h3>
      <form id="announcement-form">
        <label class="field-label">Title</label>
        <input class="field-input" id="announcement-title" required>
        <label class="field-label">Body</label>
        <textarea class="field-input field-textarea" id="announcement-body" rows="4" required></textarea>
        <label class="field-label">Audience</label>
        <select class="field-input" id="announcement-audience">
          <option value="all">Everyone</option>
          <option value="teachers">Teachers only</option>
          <option value="parents">Parents only</option>
        </select>
        <div class="form-actions">
          <button type="submit" class="btn btn-primary">Save as draft</button>
        </div>
      </form>
    </div>
    <div id="announcements-list"></div>
  `;

  document.getElementById('announcement-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    showLoading();
    try {
      const { error } = await supabaseClient.from('announcements').insert({
        title: document.getElementById('announcement-title').value.trim(),
        body: document.getElementById('announcement-body').value.trim(),
        audience: document.getElementById('announcement-audience').value,
        is_published: false,
        created_by: appState.user.id,
      });
      if (error) throw error;
      showToast('Saved as draft.', 'success');
      loadAnnouncementsScreen();
    } catch (err) {
      showToast(err.message || 'Could not save.', 'error');
    } finally {
      hideLoading();
    }
  });

  const list = document.getElementById('announcements-list');
  list.innerHTML = (announcements || []).map(a => `
    <div class="card">
      <div class="class-card-header">
        <h3>${escapeHtml(a.title)} <span class="badge ${a.is_published ? 'badge-success' : 'badge-gold'}">${a.is_published ? 'Published' : 'Draft'}</span> <span class="badge badge-navy">${escapeHtml(a.audience)}</span></h3>
        <div class="row-actions">
          ${!a.is_published ? `<button type="button" class="icon-btn" data-publish-ann="${a.id}">Publish</button>` : `<button type="button" class="icon-btn" data-unpublish-ann="${a.id}">Unpublish</button>`}
          <button type="button" class="icon-btn icon-btn-danger" data-delete-ann="${a.id}">Delete</button>
        </div>
      </div>
      <p>${escapeHtml(a.body)}</p>
    </div>
  `).join('') || '<p class="view-subheading">No announcements yet.</p>';

  list.querySelectorAll('[data-publish-ann]').forEach(btn => btn.addEventListener('click', () => setAnnouncementPublished(btn.dataset.publishAnn, true)));
  list.querySelectorAll('[data-unpublish-ann]').forEach(btn => btn.addEventListener('click', () => setAnnouncementPublished(btn.dataset.unpublishAnn, false)));
  list.querySelectorAll('[data-delete-ann]').forEach(btn => btn.addEventListener('click', async () => {
    if (!confirm('Delete this announcement permanently?')) return;
    showLoading();
    try {
      const { error } = await supabaseClient.from('announcements').delete().eq('id', btn.dataset.deleteAnn);
      if (error) throw error;
      loadAnnouncementsScreen();
    } catch (err) {
      showToast(err.message || 'Could not delete.', 'error');
    } finally {
      hideLoading();
    }
  }));
}

async function setAnnouncementPublished(id, published) {
  showLoading();
  try {
    const { error } = await supabaseClient.from('announcements').update({ is_published: published }).eq('id', id);
    if (error) throw error;
    loadAnnouncementsScreen();
  } catch (err) {
    showToast(err.message || 'Could not update.', 'error');
  } finally {
    hideLoading();
  }
}

async function renderReadOnlyAnnouncementsScreen(container) {
  const { data: announcements } = await supabaseClient.from('announcements').select('*').order('created_at', { ascending: false });
  if (!announcements || announcements.length === 0) {
    container.innerHTML = `<div class="card card-notice"><p>No announcements right now.</p></div>`;
    return;
  }
  container.innerHTML = announcements.map(a => `
    <div class="card">
      <h2 class="card-title">${escapeHtml(a.title)}</h2>
      <p>${escapeHtml(a.body)}</p>
      <p class="view-subheading">${new Date(a.created_at).toLocaleDateString()}</p>
    </div>`).join('');
}

/* ----------------------------------------------------------------------------
   25. ACADEMIC CALENDAR (Phase 8)
   ---------------------------------------------------------------------------- */
async function loadCalendarScreen() {
  const container = document.getElementById('calendar-content');
  const sub = document.getElementById('calendar-subheading');
  sub.textContent = appState.user.role === 'admin'
    ? 'Add resumption dates, breaks, exams, holidays, and PTA meetings.'
    : 'Upcoming school dates.';

  const { data: events } = await supabaseClient.from('calendar_events').select('*').order('start_date');

  const adminForm = appState.user.role === 'admin' ? `
    <div class="inline-form-card">
      <h3>Add event</h3>
      <form id="calendar-form">
        <div class="form-grid">
          <div><label class="field-label">Title</label><input class="field-input" id="cal-title" required></div>
          <div><label class="field-label">Type</label>
            <select class="field-input" id="cal-type">
              <option value="resumption">Resumption</option>
              <option value="break">Break</option>
              <option value="exam">Exam period</option>
              <option value="holiday">Holiday</option>
              <option value="pta">PTA meeting</option>
              <option value="other">Other</option>
            </select>
          </div>
          <div><label class="field-label">Start date</label><input class="field-input" type="date" id="cal-start" required></div>
          <div><label class="field-label">End date (optional)</label><input class="field-input" type="date" id="cal-end"></div>
        </div>
        <label class="field-label">Description</label>
        <textarea class="field-input field-textarea" id="cal-description" rows="2"></textarea>
        <div class="form-actions"><button type="submit" class="btn btn-primary">Add event</button></div>
      </form>
    </div>` : '';

  container.innerHTML = `
    ${adminForm}
    <table class="data-table">
      <thead><tr><th>Date</th><th>Title</th><th>Type</th><th>Description</th>${appState.user.role === 'admin' ? '<th></th>' : ''}</tr></thead>
      <tbody>
        ${(events || []).length === 0 ? `<tr class="empty-row"><td colspan="5">No events yet.</td></tr>` : events.map(e => `
          <tr>
            <td>${e.start_date}${e.end_date ? ` – ${e.end_date}` : ''}</td>
            <td>${escapeHtml(e.title)}</td>
            <td><span class="badge badge-navy">${escapeHtml(e.event_type || 'other')}</span></td>
            <td>${escapeHtml(e.description || '—')}</td>
            ${appState.user.role === 'admin' ? `<td><button type="button" class="icon-btn icon-btn-danger" data-delete-event="${e.id}">Delete</button></td>` : ''}
          </tr>`).join('')}
      </tbody>
    </table>
  `;

  if (appState.user.role === 'admin') {
    document.getElementById('calendar-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      showLoading();
      try {
        const { error } = await supabaseClient.from('calendar_events').insert({
          title: document.getElementById('cal-title').value.trim(),
          event_type: document.getElementById('cal-type').value,
          start_date: document.getElementById('cal-start').value,
          end_date: document.getElementById('cal-end').value || null,
          description: document.getElementById('cal-description').value.trim(),
          created_by: appState.user.id,
        });
        if (error) throw error;
        showToast('Event added.', 'success');
        loadCalendarScreen();
      } catch (err) {
        showToast(err.message || 'Could not add event.', 'error');
      } finally {
        hideLoading();
      }
    });
    container.querySelectorAll('[data-delete-event]').forEach(btn => btn.addEventListener('click', async () => {
      if (!confirm('Delete this event?')) return;
      showLoading();
      try {
        const { error } = await supabaseClient.from('calendar_events').delete().eq('id', btn.dataset.deleteEvent);
        if (error) throw error;
        loadCalendarScreen();
      } catch (err) {
        showToast(err.message || 'Could not delete event.', 'error');
      } finally {
        hideLoading();
      }
    }));
  }
}

/* ----------------------------------------------------------------------------
   26. AUDIT LOG (Phase 8)
   ---------------------------------------------------------------------------- */
let auditLogOffset = 0;
const AUDIT_LOG_PAGE_SIZE = 25;

async function loadAuditLogScreen() {
  auditLogOffset = 0;
  const container = document.getElementById('auditlog-content');
  container.innerHTML = `
    <div class="table-toolbar">
      <select class="table-search" id="auditlog-table-filter">
        <option value="">All tables</option>
        <option value="results">results</option>
        <option value="students">students</option>
        <option value="staff">staff</option>
        <option value="users">users</option>
        <option value="promotions">promotions</option>
      </select>
      <span></span>
    </div>
    <table class="data-table">
      <thead><tr><th>When</th><th>User</th><th>Action</th><th>Table</th><th>Record</th><th></th></tr></thead>
      <tbody id="auditlog-body"></tbody>
    </table>
    <div class="form-actions"><button type="button" class="btn btn-ghost-dark" id="auditlog-load-more-btn">Load more</button></div>
  `;
  document.getElementById('auditlog-table-filter').addEventListener('change', () => { auditLogOffset = 0; document.getElementById('auditlog-body').innerHTML = ''; loadAuditLogPage(); });
  document.getElementById('auditlog-load-more-btn').addEventListener('click', loadAuditLogPage);
  loadAuditLogPage();
}

async function loadAuditLogPage() {
  const tableFilter = document.getElementById('auditlog-table-filter').value;
  let q = supabaseClient.from('audit_log').select('*, users(full_name)')
    .order('created_at', { ascending: false })
    .range(auditLogOffset, auditLogOffset + AUDIT_LOG_PAGE_SIZE - 1);
  if (tableFilter) q = q.eq('table_name', tableFilter);
  const { data, error } = await q;
  if (error) { showToast(error.message, 'error'); return; }

  const tbody = document.getElementById('auditlog-body');
  (data || []).forEach(r => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${new Date(r.created_at).toLocaleString()}</td>
      <td>${escapeHtml(r.users?.full_name || 'System')}</td>
      <td><span class="badge badge-navy">${escapeHtml(r.action_type)}</span></td>
      <td>${escapeHtml(r.table_name)}</td>
      <td style="font-family:var(--font-mono);font-size:11px;">${escapeHtml((r.record_id || '').slice(0, 8))}</td>
      <td><button type="button" class="icon-btn" data-toggle-diff>Details</button></td>
    `;
    const diffRow = document.createElement('tr');
    diffRow.className = 'hidden';
    diffRow.innerHTML = `<td colspan="6"><pre style="white-space:pre-wrap;font-size:11px;background:var(--color-paper);padding:10px;border-radius:6px;">${escapeHtml(JSON.stringify({ old: r.old_value, new: r.new_value }, null, 2))}</pre></td>`;
    tr.querySelector('[data-toggle-diff]').addEventListener('click', () => diffRow.classList.toggle('hidden'));
    tbody.appendChild(tr);
    tbody.appendChild(diffRow);
  });

  auditLogOffset += AUDIT_LOG_PAGE_SIZE;
  document.getElementById('auditlog-load-more-btn').style.display = (data || []).length < AUDIT_LOG_PAGE_SIZE ? 'none' : '';
}

/* ----------------------------------------------------------------------------
   27. SCHOOL SETTINGS + BACKUP EXPORT (Phase 8)
   ---------------------------------------------------------------------------- */
async function loadSettingsScreen() {
  const container = document.getElementById('settings-content');
  const s = appState.schoolSettings || {};

  container.innerHTML = `
    <div class="card">
      <h2 class="card-title">Identity &amp; branding</h2>
      <div class="form-grid">
        <div><label class="field-label">School name</label><input class="field-input" id="set-school-name" value="${escapeHtml(s.school_name || '')}"></div>
        <div><label class="field-label">Motto</label><input class="field-input" id="set-motto" value="${escapeHtml(s.motto || '')}"></div>
        <div><label class="field-label">Phone</label><input class="field-input" id="set-phone" value="${escapeHtml(s.phone || '')}"></div>
        <div><label class="field-label">Email</label><input class="field-input" id="set-email" value="${escapeHtml(s.email || '')}"></div>
        <div><label class="field-label">Address</label><input class="field-input" id="set-address" value="${escapeHtml(s.address || '')}"></div>
        <div><label class="field-label">Principal's name</label><input class="field-input" id="set-principal-name" value="${escapeHtml(s.principal_name || '')}"></div>
        <div><label class="field-label">Theme color</label><input class="field-input" type="color" id="set-theme-color" value="${s.theme_color || '#1B2A4A'}"></div>
        <div><label class="field-label">New logo (optional)</label><input class="field-input" type="file" id="set-logo-file" accept="image/*"></div>
        <div><label class="field-label">New principal signature (optional)</label><input class="field-input" type="file" id="set-signature-file" accept="image/*"></div>
        <div><label class="field-label">New report watermark (optional)</label><input class="field-input" type="file" id="set-watermark-file" accept="image/*"></div>
      </div>
      <div class="form-actions"><button type="button" class="btn btn-primary" id="save-settings-btn">Save settings</button></div>
    </div>

    <div class="card">
      <h2 class="card-title">Email notifications</h2>
      <p class="view-subheading">Powered by a small Google Apps Script Web App you deploy once (see apps-script/Code.gs). Once set, the system emails staff/parents an activation invite when added, and emails parents when a report card is published.</p>
      <label class="field-label" for="set-webhook-url">Apps Script webhook URL</label>
      <input class="field-input" id="set-webhook-url" placeholder="https://script.google.com/macros/s/.../exec" value="${escapeHtml(s.apps_script_webhook_url || '')}">
      <div class="form-actions">
        <button type="button" class="btn btn-ghost-dark" id="test-webhook-btn">Send test email to school address</button>
      </div>
    </div>

    <div class="card">
      <h2 class="card-title">Backup / export</h2>
      <p class="view-subheading">Downloads a JSON snapshot of core data. Destructive actions elsewhere in the app already require confirmation, so this is for off-site backup, not undo.</p>
      <div class="form-actions" style="flex-wrap:wrap;">
        <button type="button" class="btn btn-ghost-dark" data-export="students">Export students</button>
        <button type="button" class="btn btn-ghost-dark" data-export="results">Export results</button>
        <button type="button" class="btn btn-ghost-dark" data-export="report_cards">Export report cards</button>
        <button type="button" class="btn btn-ghost-dark" data-export="attendance">Export attendance</button>
        <button type="button" class="btn btn-ghost-dark" data-export="audit_log">Export audit log</button>
      </div>
    </div>
  `;

  document.getElementById('save-settings-btn').addEventListener('click', async () => {
    showLoading();
    try {
      const patch = {
        school_name: document.getElementById('set-school-name').value.trim(),
        motto: document.getElementById('set-motto').value.trim(),
        phone: document.getElementById('set-phone').value.trim(),
        email: document.getElementById('set-email').value.trim(),
        address: document.getElementById('set-address').value.trim(),
        principal_name: document.getElementById('set-principal-name').value.trim(),
        theme_color: document.getElementById('set-theme-color').value,
        apps_script_webhook_url: document.getElementById('set-webhook-url').value.trim() || null,
        updated_at: new Date().toISOString(),
      };
      const logoFile = document.getElementById('set-logo-file').files[0];
      const sigFile = document.getElementById('set-signature-file').files[0];
      const watermarkFile = document.getElementById('set-watermark-file').files[0];
      const logoUrl = await uploadSchoolAsset(logoFile, 'logo');
      if (logoUrl) patch.logo_url = logoUrl;
      const sigUrl = await uploadSchoolAsset(sigFile, 'signatures');
      if (sigUrl) patch.principal_signature_url = sigUrl;
      const watermarkUrl = await uploadSchoolAsset(watermarkFile, 'watermarks');
      if (watermarkUrl) patch.report_watermark_url = watermarkUrl;

      const { data, error } = await supabaseClient.from('school_settings').update(patch).eq('id', true).select().single();
      if (error) throw error;
      setState({ schoolSettings: data });
      applySchoolBranding(data);
      showToast('Settings saved.', 'success');
    } catch (err) {
      showToast(err.message || 'Could not save settings.', 'error');
    } finally {
      hideLoading();
    }
  });

  container.querySelectorAll('[data-export]').forEach(btn => {
    btn.addEventListener('click', () => exportTableAsJSON(btn.dataset.export));
  });

  document.getElementById('test-webhook-btn').addEventListener('click', async () => {
    const url = document.getElementById('set-webhook-url').value.trim();
    const schoolEmail = document.getElementById('set-email').value.trim();
    if (!url) { showToast('Enter and save a webhook URL first.', 'error'); return; }
    if (!schoolEmail) { showToast('Enter and save a school email first.', 'error'); return; }
    showLoading();
    try {
      const res = await fetch(url, {
        method: 'POST',
        body: JSON.stringify({ type: 'notify', to: schoolEmail, subject: 'Test email', body: 'This is a test email from your Result Management System. If you received this, email notifications are working.' }),
      });
      const data = await res.json().catch(() => null);
      if (data && data.error) throw new Error(data.error);
      showToast(`Test email sent to ${schoolEmail}. Check the inbox.`, 'success');
    } catch (err) {
      showToast(err.message || 'Could not reach the Apps Script webhook. Double-check the URL and that it\'s deployed with "Anyone" access.', 'error');
    } finally {
      hideLoading();
    }
  });
}

async function exportTableAsJSON(table) {
  showLoading();
  try {
    const { data, error } = await supabaseClient.from(table).select('*');
    if (error) throw error;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${table}-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast(`Exported ${data.length} row(s) from ${table}.`, 'success');
  } catch (err) {
    showToast(err.message || 'Export failed.', 'error');
  } finally {
    hideLoading();
  }
}

/* ----------------------------------------------------------------------------
   28. BOOTSTRAP — wire up events, restore session on reload
   ---------------------------------------------------------------------------- */
async function bootstrap() {
  document.getElementById('login-form').addEventListener('submit', handleLoginSubmit);
  document.getElementById('forgot-password-btn').addEventListener('click', handleForgotPassword);
  document.getElementById('show-activate-btn').addEventListener('click', () => showActivateForm(true));
  document.getElementById('back-to-login-btn').addEventListener('click', () => showActivateForm(false));
  document.getElementById('activate-form').addEventListener('submit', handleActivateSubmit);
  document.getElementById('show-contact-btn').addEventListener('click', () => showContactForm(true));
  document.getElementById('back-to-login-from-contact-btn').addEventListener('click', () => showContactForm(false));
  document.getElementById('contact-form').addEventListener('submit', handleContactSubmit);
  document.getElementById('logout-btn').addEventListener('click', handleLogout);
  document.getElementById('sidebar-toggle-btn').addEventListener('click', toggleSidebar);
  document.getElementById('sidebar-backdrop').addEventListener('click', closeMobileSidebar);

  showLoading();
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (session && session.user) {
    await loadUserProfileAndEnterApp(session.user);
  } else {
    // Load public branding (logo/name/color) so even the login screen
    // reflects real school settings without requiring auth first.
    await loadSchoolSettings();
    showView('login');
  }
  hideLoading();
}

document.addEventListener('DOMContentLoaded', bootstrap);
