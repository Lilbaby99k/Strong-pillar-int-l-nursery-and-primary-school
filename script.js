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
    { key: 'announcements', label: 'Announcements', icon: '◆' },
    { key: 'settings', label: 'School Settings', icon: '◆' },
  ],
  teacher: [
    { key: 'dashboard', label: 'Dashboard', icon: '◆' },
    { key: 'myclass', label: 'My Class', icon: '◆' },
    { key: 'results', label: 'Enter Results', icon: '◆' },
    { key: 'reportcards', label: 'Report Cards', icon: '◆' },
    { key: 'announcements', label: 'Announcements', icon: '◆' },
  ],
  parent: [
    { key: 'dashboard', label: 'Dashboard', icon: '◆' },
    { key: 'reportcards', label: 'Report Cards', icon: '◆' },
    { key: 'announcements', label: 'Announcements', icon: '◆' },
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

  const { error: claimErr } = await supabaseClient
    .from('pending_accounts')
    .update({ claimed: true })
    .eq('id', pending.id);
  if (claimErr) {
    // The account is fully created and usable at this point — this is
    // just the "mark the invite used" step. If it fails, don't block the
    // person from getting into the app; just log it so it's traceable
    // instead of failing invisibly. The Staff/Parents screens also filter
    // out any invite whose email already has an active account (below),
    // so a leftover unclaimed invite here won't show as a stale
    // "Pending activation" duplicate either way.
    console.error('Could not mark invite as claimed:', claimErr.message);
  }
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
function showLoginPanel(panel) {
  document.querySelector('.login-form-pane > .login-form-card').classList.toggle('hidden', panel !== 'signin');
  document.getElementById('activate-form-card').classList.toggle('hidden', panel !== 'activate');
  document.getElementById('register-form-card').classList.toggle('hidden', panel !== 'register');
  document.getElementById('contact-form-card').classList.toggle('hidden', panel !== 'contact');
  document.getElementById('reset-form-card').classList.toggle('hidden', panel !== 'reset');
}
function showActivateForm(show) { showLoginPanel(show ? 'activate' : 'signin'); }
function showRegisterForm(show) {
  showLoginPanel(show ? 'register' : 'signin');
  if (show) resetRegisterForm();
}
function showContactForm(show) { showLoginPanel(show ? 'contact' : 'signin'); }
function showResetForm(show) {
  showLoginPanel(show ? 'reset' : 'signin');
  if (show) resetPasswordResetForm();
}

/* ---- Parent self-registration ---------------------------------------------
   Parts 4-6 of the module spec: a parent creates their OWN account (no admin
   step) and links it to one or more children by admission number. Linking is
   verified server-side by link_parent_to_student() (see the migration SQL) —
   it checks the admission number exists, isn't graduated, and that the phone
   on this registration matches the phone on file for that student, then sets
   students.parent_id = this new user, all inside a SECURITY DEFINER function
   so a brand-new account can't otherwise read or edit the students table.
   ---------------------------------------------------------------------------- */
function renderRegisterChildRows() {
  const count = Number(document.getElementById('register-child-count').value);
  const container = document.getElementById('register-children-rows');
  const current = container.querySelectorAll('.wizard-repeat-row').length;
  if (count > current) {
    for (let i = current; i < count; i++) addRegisterChildRow();
  } else if (count < current) {
    const rows = container.querySelectorAll('.wizard-repeat-row');
    for (let i = current - 1; i >= count; i--) rows[i].remove();
  }
}

function addRegisterChildRow() {
  const container = document.getElementById('register-children-rows');
  const row = document.createElement('div');
  row.className = 'wizard-repeat-row';
  row.innerHTML = `
    <input class="field-input" placeholder="Child's admission number (e.g. PS202600001)" data-admission-input>
    <button type="button" class="wizard-remove-row-btn">Remove</button>
  `;
  row.querySelector('.wizard-remove-row-btn').addEventListener('click', () => {
    row.remove();
    document.getElementById('register-child-count').value = Math.max(1,
      document.getElementById('register-children-rows').querySelectorAll('.wizard-repeat-row').length);
  });
  container.appendChild(row);
}

function resetRegisterForm() {
  document.getElementById('register-form').reset();
  document.getElementById('register-children-rows').innerHTML = '';
  document.getElementById('register-error').classList.add('hidden');
  document.getElementById('register-notice').classList.add('hidden');
  renderRegisterChildRows();
}

async function handleRegisterSubmit(event) {
  event.preventDefault();
  const errorEl = document.getElementById('register-error');
  const noticeEl = document.getElementById('register-notice');
  errorEl.classList.add('hidden');
  noticeEl.classList.add('hidden');

  const fullName = document.getElementById('register-full-name').value.trim();
  const phone = document.getElementById('register-phone').value.trim();
  const email = document.getElementById('register-email').value.trim();
  const password = document.getElementById('register-password').value;
  const passwordConfirm = document.getElementById('register-password-confirm').value;
  const admissionNumbers = Array.from(document.querySelectorAll('#register-children-rows [data-admission-input]'))
    .map(i => i.value.trim())
    .filter(Boolean);

  if (!email) {
    errorEl.textContent = 'Email is required.';
    errorEl.classList.remove('hidden');
    return;
  }
  if (!looksLikeEmail(email)) {
    errorEl.textContent = 'Enter a valid email address.';
    errorEl.classList.remove('hidden');
    return;
  }
  if (password.length < 8) {
    errorEl.textContent = 'Password must be at least 8 characters.';
    errorEl.classList.remove('hidden');
    return;
  }
  if (password !== passwordConfirm) {
    errorEl.textContent = 'Passwords do not match.';
    errorEl.classList.remove('hidden');
    return;
  }
  if (admissionNumbers.length === 0) {
    errorEl.textContent = "Enter at least one child's admission number.";
    errorEl.classList.remove('hidden');
    return;
  }

  showLoading();
  try {
    const { data: signUpData, error: signUpErr } = await supabaseClient.auth.signUp({ email, password });
    if (signUpErr) throw signUpErr;
    const authUser = signUpData.user;
    if (!authUser) throw new Error('Could not create your account. Please try again.');

    const { error: userErr } = await supabaseClient.from('users').insert({
      id: authUser.id, role: 'parent', full_name: fullName, email, phone,
    });
    if (userErr) throw userErr;

    const { error: parentErr } = await supabaseClient.from('parents').insert({ id: authUser.id });
    if (parentErr) throw parentErr;

    sendAppsScriptEmail({
      to: email,
      subject: `Your ${appState.schoolSettings?.school_name || 'school'} account has been created`,
      body: `Hello ${fullName},\n\nYour parent account has been created successfully. You can sign in anytime with this email and the password you just chose to view your child's report cards and school announcements.\n\n— ${appState.schoolSettings?.school_name || 'The school'}`,
    });

    const results = [];
    for (const admissionNumber of admissionNumbers) {
      const { data: linkResult, error: linkErr } = await supabaseClient
        .rpc('link_parent_to_student', {
          p_admission_number: admissionNumber,
          p_phone: phone,
          p_parent_name: fullName,
          p_parent_email: email,
        });
      if (linkErr) {
        results.push({ admissionNumber, success: false, error: linkErr.message });
      } else {
        results.push({ admissionNumber, ...linkResult });
      }
    }

    const linked = results.filter(r => r.success);
    const failed = results.filter(r => !r.success);

    let summary = '';
    if (linked.length > 0) {
      summary += `Linked: ${linked.map(r => r.full_name || r.admissionNumber).join(', ')}. `;
    }
    if (failed.length > 0) {
      summary += `Could not link — ${failed.map(r => `${r.admissionNumber} (${r.error})`).join('; ')}. You can try again later from your dashboard.`;
    }

    // Whether or not signUp requires email confirmation, try to sign in
    // immediately — if email confirmation is on, this will simply fail
    // gracefully and the account still exists for later activation.
    const { data: signInData, error: signInErr } = await supabaseClient.auth.signInWithPassword({ email, password });
    if (signInErr) {
      noticeEl.textContent = `Account created. ${summary} Check your email to confirm your account, then sign in.`;
      noticeEl.classList.remove('hidden');
      showLoginPanel('signin');
      return;
    }

    showToast(`Welcome! ${summary}`.trim(), linked.length > 0 ? 'success' : 'error');
    await loadUserProfileAndEnterApp(signInData.user);
  } catch (err) {
    errorEl.textContent = err.message || 'Could not create your account.';
    errorEl.classList.remove('hidden');
  } finally {
    hideLoading();
  }
}

async function handleContactSubmit(event) {
  event.preventDefault();
  const name = document.getElementById('contact-name').value.trim();
  const email = document.getElementById('contact-email').value.trim();
  const message = document.getElementById('contact-message').value.trim();
  const errorEl = document.getElementById('contact-error');
  const noticeEl = document.getElementById('contact-notice');
  errorEl.classList.add('hidden');
  noticeEl.classList.add('hidden');

  const webhookUrl = APPS_SCRIPT_WEBHOOK_URL;
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
  subscribeToActiveTermChanges();

  // Establish the app's very first history entry with replaceState (not
  // pushState) so this dashboard load doesn't stack on top of whatever
  // page the browser was on before sign-in — from here on, navigateTo()
  // pushes a new entry per screen, so Back moves screen-by-screen inside
  // the app instead of leaving it.
  history.replaceState({ viewKey: 'dashboard' }, '', '#dashboard');
  navigateTo('dashboard', true);

  if (appState.user.role === 'admin') checkSessionRolloverPrompt();

  const pendingRc = sessionStorage.getItem('pendingReportCardId');
  if (pendingRc) {
    sessionStorage.removeItem('pendingReportCardId');
    openReportCardPreview(pendingRc);
  }
}

// Builds the link an emailed "report card published" notification points
// to — opens straight to that report card once the recipient signs in.
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
  announcements: loadAnnouncementsScreen,
  settings: loadSettingsScreen,
};

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

      // If a previous attempt with this same session name got partway
      // through (session created, but then failed before its terms were
      // saved — e.g. this exact bug, now fixed, used to do that), that
      // orphaned session row is still in the database and its name will
      // collide with this new attempt. Clear out any same-named session
      // that has zero terms before creating the real one, so retrying
      // after a failed attempt just works instead of requiring manual
      // SQL cleanup each time.
      const { data: existingSessions } = await supabaseClient
        .from('sessions')
        .select('id, terms(id)')
        .eq('name', sessionName);
      const orphanIds = (existingSessions || []).filter(s => !s.terms || s.terms.length === 0).map(s => s.id);
      if (orphanIds.length > 0) {
        await supabaseClient.from('sessions').delete().in('id', orphanIds);
      }

      const { data: session, error: sessionErr } = await supabaseClient
        .from('sessions')
        .insert({ name: sessionName, is_active: true })
        .select()
        .single();
      if (sessionErr) throw sessionErr;

      const termRows = Array.from(document.querySelectorAll('#wizard-step-2 .wizard-term-row')).map(row => ({
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

  /* ---- Step 3: Classes ---------------------------------------------------- */
  document.getElementById('wizard-add-class-row').addEventListener('click', addWizardClassRow);

  document.getElementById('wizard-step-3').addEventListener('submit', async (e) => {
    e.preventDefault();
    showLoading();
    try {
      const rows = Array.from(document.querySelectorAll('#wizard-class-rows .wizard-repeat-row'))
        .map(row => row.querySelector('[data-field="class-name"]').value.trim())
        .filter(Boolean);

      if (rows.length === 0) throw new Error('Add at least one class before continuing.');

      for (let i = 0; i < rows.length; i++) {
        const { data: cls, error: clsErr } = await supabaseClient
          .from('classes')
          .insert({ name: rows[i], sort_order: i })
          .select()
          .single();
        if (clsErr) throw clsErr;

        // Every class gets a single hidden arm behind the scenes — the app
        // doesn't expose "arms" to the user at all.
        const { error: armErr } = await supabaseClient.from('class_arms').insert({ class_id: cls.id, name: 'A' });
        if (armErr) throw armErr;
      }

      showToast('Classes saved.', 'success');
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
async function sendAppsScriptEmail(payload) {
  const url = APPS_SCRIPT_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, { method: 'POST', body: JSON.stringify({ type: 'notify', ...payload }) });
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
    await fetch(url, { method: 'POST', body: JSON.stringify({ type: 'bulk', recipients, subject, body }) });
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
        id: s.id,
        pendingId: null,
        full_name: s.users.full_name,
        email: s.users.email,
        phone: s.users.phone,
        role: s.users.role,
        staff_number: s.staff_number,
        employed_date: s.employed_date,
        assigned_arm: arm ? arm.classes.name : '—',
        status: 'active',
      };
    });

  const { data: pendingRows } = await supabaseClient
    .from('pending_accounts')
    .select('*')
    .in('role', ['admin', 'teacher'])
    .eq('claimed', false);

  const activeEmails = new Set(activeRows.map(r => (r.email || '').toLowerCase()));

  const pending = (pendingRows || [])
    .filter(p => !activeEmails.has((p.email || '').toLowerCase()))
    .map(p => ({
    id: null,
    pendingId: p.id,
    full_name: p.full_name,
    email: p.email,
    phone: p.phone,
    role: p.role,
    staff_number: p.staff_number,
    employed_date: p.employed_date,
    assigned_arm: '—',
    status: 'pending',
  }));

  staffCache = [...activeRows, ...pending];
  renderStaffTable(staffCache);
}

let staffEditContext = null; // { id, pendingId } of row currently being edited, or null when adding

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
      <td>
        <button type="button" class="icon-btn" data-edit-staff="${r.id || ''}" data-edit-staff-pending="${r.pendingId || ''}">Edit</button>
        ${r.pendingId ? `<button type="button" class="icon-btn icon-btn-danger" data-cancel-pending-staff="${r.pendingId}">Cancel invite</button>` : ''}
      </td>
    </tr>
  `).join('');

  tbody.querySelectorAll('[data-edit-staff]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.editStaff || null;
      const pendingId = btn.dataset.editStaffPending || null;
      const row = staffCache.find(r => (id && r.id === id) || (pendingId && r.pendingId === pendingId));
      if (row) openStaffEditForm(row);
    });
  });

  tbody.querySelectorAll('[data-cancel-pending-staff]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!await showConfirmDialog('They will no longer be able to activate with this email.', { title: 'Cancel this invite?', confirmLabel: 'Cancel invite', danger: true })) return;
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

function openStaffEditForm(row) {
  staffEditContext = { id: row.id, pendingId: row.pendingId };
  document.getElementById('staff-full-name').value = row.full_name || '';
  document.getElementById('staff-email').value = row.email || '';
  document.getElementById('staff-phone').value = row.phone || '';
  document.getElementById('staff-role').value = row.role || 'teacher';
  document.getElementById('staff-number').value = row.staff_number || '';
  document.getElementById('staff-employed-date').value = row.employed_date || '';

  const emailInput = document.getElementById('staff-email');
  const note = document.getElementById('staff-form-note');
  if (row.status === 'active') {
    emailInput.setAttribute('readonly', 'readonly');
    note.textContent = "Email can't be changed here for an active account since it's tied to their login — other fields update immediately.";
  } else {
    emailInput.removeAttribute('readonly');
    note.textContent = 'No password needed here — they\'ll set their own the first time they sign in, using this email, via "Activate your account" on the login screen.';
  }

  document.getElementById('staff-form-heading').textContent = 'Edit staff or teacher';
  document.getElementById('staff-form-submit').textContent = 'Save changes';
  toggleInlineForm('staff-form-card', true);
}

function resetStaffForm() {
  staffEditContext = null;
  document.getElementById('staff-form').reset();
  document.getElementById('staff-email').removeAttribute('readonly');
  document.getElementById('staff-form-heading').textContent = 'Add staff or teacher';
  document.getElementById('staff-form-submit').textContent = 'Save';
  document.getElementById('staff-form-note').textContent = 'No password needed here — they\'ll set their own the first time they sign in, using this email, via "Activate your account" on the login screen.';
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('staff-add-btn').addEventListener('click', () => {
    resetStaffForm();
    toggleInlineForm('staff-form-card', true);
  });
  document.getElementById('staff-form-cancel').addEventListener('click', () => {
    resetStaffForm();
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
      const phone = document.getElementById('staff-phone').value.trim();
      const role = document.getElementById('staff-role').value;
      const staffNumber = document.getElementById('staff-number').value.trim() || null;
      const employedDate = document.getElementById('staff-employed-date').value || null;

      if (staffEditContext && staffEditContext.id) {
        // Editing an active staff/teacher account
        const { error: userErr } = await supabaseClient
          .from('users').update({ full_name: fullName, phone, role }).eq('id', staffEditContext.id);
        if (userErr) throw userErr;
        const { error: staffErr } = await supabaseClient
          .from('staff').update({ staff_number: staffNumber, employed_date: employedDate }).eq('id', staffEditContext.id);
        if (staffErr) throw staffErr;
        showToast('Staff details updated.', 'success');
      } else if (staffEditContext && staffEditContext.pendingId) {
        // Editing a not-yet-activated invite
        const { error } = await supabaseClient.from('pending_accounts').update({
          full_name: fullName, email, phone, role, staff_number: staffNumber, employed_date: employedDate,
        }).eq('id', staffEditContext.pendingId);
        if (error) throw error;
        showToast('Invite details updated.', 'success');
      } else {
        // Adding a new staff/teacher
        const { error } = await supabaseClient.from('pending_accounts').insert({
          full_name: fullName,
          email: email,
          phone: phone,
          role: role,
          staff_number: staffNumber,
          employed_date: employedDate,
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
      }

      resetStaffForm();
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
    .select('id, address, users(full_name, email, phone)');
  if (error) { showToast(error.message, 'error'); return; }

  const { data: students } = await supabaseClient.from('students').select('parent_id');
  const childCounts = {};
  (students || []).forEach(s => { if (s.parent_id) childCounts[s.parent_id] = (childCounts[s.parent_id] || 0) + 1; });

  const activeRows = (parentRows || [])
    .filter(p => p.users)
    .map(p => ({
      id: p.id,
      pendingId: null,
      full_name: p.users.full_name,
      email: p.users.email,
      phone: p.users.phone,
      address: p.address,
      children: childCounts[p.id] || 0,
      status: 'active',
    }));

  const { data: pendingRows } = await supabaseClient
    .from('pending_accounts')
    .select('*')
    .eq('role', 'parent')
    .eq('claimed', false);

  const activeParentEmails = new Set(activeRows.map(r => (r.email || '').toLowerCase()));

  const pending = (pendingRows || [])
    .filter(p => !activeParentEmails.has((p.email || '').toLowerCase()))
    .map(p => ({
    id: null,
    pendingId: p.id,
    full_name: p.full_name,
    email: p.email,
    phone: p.phone,
    address: p.address,
    children: 0,
    status: 'pending',
  }));

  parentCache = [...activeRows, ...pending];
  renderParentTable(parentCache);
}

let parentEditContext = null; // { id, pendingId } of row currently being edited, or null when adding

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
      <td>
        <button type="button" class="icon-btn" data-edit-parent="${r.id || ''}" data-edit-parent-pending="${r.pendingId || ''}">Edit</button>
        ${r.pendingId ? `<button type="button" class="icon-btn icon-btn-danger" data-cancel-pending-parent="${r.pendingId}">Cancel invite</button>` : ''}
      </td>
    </tr>
  `).join('');

  tbody.querySelectorAll('[data-edit-parent]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.editParent || null;
      const pendingId = btn.dataset.editParentPending || null;
      const row = parentCache.find(r => (id && r.id === id) || (pendingId && r.pendingId === pendingId));
      if (row) openParentEditForm(row);
    });
  });

  tbody.querySelectorAll('[data-cancel-pending-parent]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!await showConfirmDialog('This invite will no longer be usable.', { title: 'Cancel this invite?', confirmLabel: 'Cancel invite', danger: true })) return;
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

function openParentEditForm(row) {
  parentEditContext = { id: row.id, pendingId: row.pendingId };
  document.getElementById('parent-full-name').value = row.full_name || '';
  document.getElementById('parent-email').value = row.email || '';
  document.getElementById('parent-phone').value = row.phone || '';
  document.getElementById('parent-address').value = row.address || '';

  const emailInput = document.getElementById('parent-email');
  const note = document.getElementById('parent-form-note');
  if (row.status === 'active') {
    emailInput.setAttribute('readonly', 'readonly');
    note.textContent = "Email can't be changed here for an active account since it's tied to their login — other fields update immediately.";
  } else {
    emailInput.removeAttribute('readonly');
    note.textContent = 'No password needed here — they\'ll set their own the first time they sign in, using this email, via "Activate your account" on the login screen.';
  }

  document.getElementById('parent-form-heading').textContent = 'Edit parent';
  document.getElementById('parent-form-submit').textContent = 'Save changes';
  toggleInlineForm('parent-form-card', true);
}

function resetParentForm() {
  parentEditContext = null;
  document.getElementById('parent-form').reset();
  document.getElementById('parent-email').removeAttribute('readonly');
  document.getElementById('parent-form-heading').textContent = 'Add parent';
  document.getElementById('parent-form-submit').textContent = 'Save';
  document.getElementById('parent-form-note').textContent = 'No password needed here — they\'ll set their own the first time they sign in, using this email, via "Activate your account" on the login screen.';
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('parent-add-btn').addEventListener('click', () => {
    resetParentForm();
    toggleInlineForm('parent-form-card', true);
  });
  document.getElementById('parent-form-cancel').addEventListener('click', () => {
    resetParentForm();
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
      const phone = document.getElementById('parent-phone').value.trim();
      const address = document.getElementById('parent-address').value.trim();

      if (parentEditContext && parentEditContext.id) {
        // Editing an active parent account
        const { error: userErr } = await supabaseClient
          .from('users').update({ full_name: fullName, phone }).eq('id', parentEditContext.id);
        if (userErr) throw userErr;
        const { error: parentErr } = await supabaseClient
          .from('parents').update({ address }).eq('id', parentEditContext.id);
        if (parentErr) throw parentErr;
        showToast('Parent details updated.', 'success');
      } else if (parentEditContext && parentEditContext.pendingId) {
        // Editing a not-yet-activated invite
        const { error } = await supabaseClient.from('pending_accounts').update({
          full_name: fullName, email, phone, address,
        }).eq('id', parentEditContext.pendingId);
        if (error) throw error;
        showToast('Invite details updated.', 'success');
      } else {
        // Adding a new parent
        const { error } = await supabaseClient.from('pending_accounts').insert({
          full_name: fullName,
          email: email,
          phone: phone,
          address: address,
          role: 'parent',
          created_by: appState.user.id,
        });
        if (error) throw error;

        sendAppsScriptEmail({
          type: 'notify',
          to: email,
          subject: `You've been added to ${appState.schoolSettings?.school_name || 'the school'}'s system`,
          body: `Hello ${fullName},\n\nA parent account has been set up for you on ${appState.schoolSettings?.school_name || 'the school'}'s Result Management System, so you can view your child's report cards and school announcements.\n\nTo activate it, go to the login page, click "Staff or parent? Activate your account," and enter this email address (${email}) along with a password of your choosing.\n\nIf you weren't expecting this, please contact the school administrator.`,
        });

        showToast('Saved. They can now activate their account using this email.', 'success');
      }

      resetParentForm();
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
  const countNote = document.getElementById('classes-count-note');
  const n = classesWithArmsCache.length;
  if (countNote) countNote.textContent = n === 0 ? 'No classes yet' : `${n} class${n === 1 ? '' : 'es'}`;

  if (n === 0) {
    container.innerHTML = `<div class="panel-empty-state">No classes yet — add your first one above.</div>`;
    return;
  }
  container.innerHTML = classesWithArmsCache.map(c => {
    const arm = c.arms[0]; // every class has exactly one hidden arm behind the scenes
    return `
    <div class="class-row">
      <span class="class-row-name">${escapeHtml(c.name)}</span>
      ${arm ? `
        <select class="field-input" id="class-teacher-${arm.id}" data-assign-arm="${arm.id}">
          <option value="">— assign teacher —</option>
          ${teacherOptionsCache.map(t => `<option value="${t.id}" ${t.id === arm.class_teacher_id ? 'selected' : ''}>${escapeHtml(t.users.full_name)}</option>`).join('')}
        </select>
      ` : '<span></span>'}
      <div class="class-row-actions">
        <button type="button" class="class-row-subjects-btn" data-manage-subjects="${c.id}" data-class-name="${escapeHtml(c.name)}" title="Choose which subjects this class takes">Subjects</button>
        <button type="button" class="class-row-delete" data-delete-class="${c.id}" title="Delete class" aria-label="Delete ${escapeHtml(c.name)}">✕</button>
      </div>
    </div>
  `;
  }).join('');

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

  container.querySelectorAll('[data-delete-class]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!await showConfirmDialog('This cannot be undone.', { title: 'Delete this entire class?', confirmLabel: 'Delete class', danger: true })) return;
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

  container.querySelectorAll('[data-manage-subjects]').forEach(btn => {
    btn.addEventListener('click', () => openClassSubjectsModal(btn.dataset.manageSubjects, btn.dataset.className));
  });
}

/* ----------------------------------------------------------------------------
   CLASS SUBJECTS MODAL — lets the admin pick exactly which subjects a given
   class takes, since not every class does the same subjects (e.g. Creche
   vs. Basic 5). This is what results entry/approvals filter subjects by,
   so getting this right is what stops a teacher from ever being able to
   enter a score for a subject their class doesn't actually take.
   ---------------------------------------------------------------------------- */
let classSubjectsModalClassId = null;

async function openClassSubjectsModal(classId, className) {
  classSubjectsModalClassId = classId;
  document.getElementById('class-subjects-modal-name').textContent = className || 'this class';

  const listEl = document.getElementById('class-subjects-modal-list');
  const emptyEl = document.getElementById('class-subjects-modal-empty');

  if (subjectsCache.length === 0) {
    listEl.classList.add('hidden');
    emptyEl.classList.remove('hidden');
  } else {
    listEl.classList.remove('hidden');
    emptyEl.classList.add('hidden');

    const { data: links } = await supabaseClient
      .from('class_subjects')
      .select('subject_id')
      .eq('class_id', classId);
    const linkedIds = new Set((links || []).map(l => l.subject_id));

    listEl.innerHTML = subjectsCache.map(s => `
      <label class="class-subjects-modal-row">
        <input type="checkbox" value="${s.id}" ${linkedIds.has(s.id) ? 'checked' : ''}>
        <span>${escapeHtml(s.name)}</span>
        ${s.code ? `<span class="subject-chip-code">${escapeHtml(s.code)}</span>` : ''}
      </label>
    `).join('');
  }

  document.getElementById('class-subjects-modal').classList.remove('hidden');
}

function closeClassSubjectsModal() {
  document.getElementById('class-subjects-modal').classList.add('hidden');
  classSubjectsModalClassId = null;
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('class-subjects-modal-cancel').addEventListener('click', closeClassSubjectsModal);

  document.getElementById('class-subjects-modal-save').addEventListener('click', async () => {
    const classId = classSubjectsModalClassId;
    if (!classId) return;

    const checkedIds = Array.from(
      document.querySelectorAll('#class-subjects-modal-list input[type="checkbox"]:checked')
    ).map(cb => cb.value);

    showLoading();
    try {
      const { data: existing, error: existingErr } = await supabaseClient
        .from('class_subjects')
        .select('subject_id')
        .eq('class_id', classId);
      if (existingErr) throw existingErr;

      const existingIds = new Set((existing || []).map(l => l.subject_id));
      const checkedSet = new Set(checkedIds);

      const toAdd = checkedIds.filter(id => !existingIds.has(id));
      const toRemove = [...existingIds].filter(id => !checkedSet.has(id));

      if (toAdd.length > 0) {
        const { error: addErr } = await supabaseClient
          .from('class_subjects')
          .insert(toAdd.map(subject_id => ({ class_id: classId, subject_id })));
        if (addErr) throw addErr;
      }
      if (toRemove.length > 0) {
        const { error: removeErr } = await supabaseClient
          .from('class_subjects')
          .delete()
          .eq('class_id', classId)
          .in('subject_id', toRemove);
        if (removeErr) throw removeErr;
      }

      showToast('Subjects updated for this class.', 'success');
      closeClassSubjectsModal();
    } catch (err) {
      showToast(err.message || 'Could not update subjects.', 'error');
    } finally {
      hideLoading();
    }
  });
});

function renderSubjectsChips() {
  const container = document.getElementById('subjects-chip-list');
  const countNote = document.getElementById('subjects-count-note');
  const n = subjectsCache.length;
  if (countNote) countNote.textContent = n === 0 ? 'No subjects yet' : `${n} subject${n === 1 ? '' : 's'}`;

  if (n === 0) {
    container.innerHTML = `<div class="panel-empty-state">No subjects yet — add your first one above.</div>`;
    return;
  }
  container.innerHTML = subjectsCache.map(s => `
    <span class="subject-chip">
      ${escapeHtml(s.name)}
      ${s.code ? `<span class="subject-chip-code">${escapeHtml(s.code)}</span>` : ''}
      <button type="button" data-delete-subject="${s.id}" title="Remove subject" aria-label="Remove ${escapeHtml(s.name)}">✕</button>
    </span>
  `).join('');

  container.querySelectorAll('[data-delete-subject]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!await showConfirmDialog('It will be removed from every class that currently teaches it.', { title: 'Remove this subject?', confirmLabel: 'Remove subject', danger: true })) return;
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
    if (!name) { showToast('Enter a class name.', 'error'); return; }
    showLoading();
    try {
      const { data: cls, error: clsErr } = await supabaseClient
        .from('classes')
        .insert({ name, sort_order: classesWithArmsCache.length })
        .select()
        .single();
      if (clsErr) throw clsErr;

      // Every class gets a single hidden arm named "A" — the app never
      // exposes "arms" to the user, this is purely internal plumbing.
      const { error: armErr } = await supabaseClient
        .from('class_arms')
        .insert({ class_id: cls.id, name: 'A' });
      if (armErr) throw armErr;

      document.getElementById('new-class-name').value = '';
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
let studentCache = [];       // students matching the currently selected tab (active or withdrawn)
let allStudentCache = [];    // every student, unfiltered — the search box and tab switch both filter from this
let studentPage = 1;
let studentStatusTab = 'active'; // 'active' | 'withdrawn'

async function populateStudentClassArmSelects() {
  await refreshClassesWithArmsCache();
  const classSelect = document.getElementById('student-class');
  classSelect.innerHTML = classesWithArmsCache.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
}

async function loadStudentsScreen() {
  studentPage = 1;
  const tbody = document.getElementById('student-table-body');
  tbody.innerHTML = `<tr class="empty-row"><td colspan="6">Loading…</td></tr>`;

  await populateStudentClassArmSelects();

  const { data: students, error } = await supabaseClient
    .from('students')
    .select('id, admission_number, full_name, gender, date_of_birth, passport_url, parent_id, parent_name, parent_phone, parent_email, enrollment_status, withdrawn_at, parent_auto_deactivated');
  if (error) { showToast(error.message, 'error'); return; }

  const { data: parents } = await supabaseClient.from('parents').select('id, users(full_name, email)');
  const linkedParentNameById = {};
  const linkedParentEmailById = {};
  (parents || []).forEach(p => {
    if (p.users) { linkedParentNameById[p.id] = p.users.full_name; linkedParentEmailById[p.id] = p.users.email; }
  });

  // Withdrawn students may have no current-term enrollment row at all (if
  // they were withdrawn a session or more ago), so this join is best-effort
  // for the "Class" column — it's never relied on for correctness.
  let enrollmentsQuery = supabaseClient
    .from('enrollments')
    .select('student_id, classes(name), class_arms(name)')
    .neq('status', 'withdrawn');
  if (appState.activeTermId) enrollmentsQuery = enrollmentsQuery.eq('term_id', appState.activeTermId);
  const { data: enrollments } = await enrollmentsQuery;
  const enrollmentByStudent = {};
  (enrollments || []).forEach(e => { enrollmentByStudent[e.student_id] = e; });

  allStudentCache = (students || []).map(s => ({
    id: s.id,
    admission_number: s.admission_number,
    full_name: s.full_name,
    gender: s.gender,
    date_of_birth: s.date_of_birth,
    passport_url: s.passport_url,
    parent_id: s.parent_id,
    parent_name: s.parent_name || '',
    parent_phone: s.parent_phone || '',
    parent_contact_email: s.parent_email || '',
    linked_parent_email: s.parent_id ? (linkedParentEmailById[s.parent_id] || '') : '',
    enrollment_status: s.enrollment_status || 'active',
    withdrawn_at: s.withdrawn_at,
    parent_auto_deactivated: !!s.parent_auto_deactivated,
    class_arm: enrollmentByStudent[s.id]
      ? (enrollmentByStudent[s.id].classes?.name || '—')
      : 'Not enrolled this term',
    display_parent_name: s.parent_id ? (linkedParentNameById[s.parent_id] || s.parent_name || '—') : (s.parent_name || 'Unlinked'),
  }));

  applyStudentTabFilter();
}

// Re-derives studentCache from allStudentCache for the current tab, and
// re-renders. Called on tab switch and after any load/refresh.
function applyStudentTabFilter() {
  document.querySelectorAll('#student-status-tabs [data-student-tab]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.studentTab === studentStatusTab);
  });
  document.getElementById('student-withdrawn-note').classList.toggle('hidden', studentStatusTab !== 'withdrawn');
  document.getElementById('student-add-btn').classList.toggle('hidden', studentStatusTab === 'withdrawn');

  const head = document.getElementById('student-table-head');
  head.innerHTML = studentStatusTab === 'withdrawn'
    ? '<tr><th>Adm. No.</th><th>Name</th><th>Gender</th><th>Withdrawn on</th><th>Parent</th><th></th></tr>'
    : '<tr><th>Adm. No.</th><th>Name</th><th>Gender</th><th>Class</th><th>Parent</th><th></th></tr>';

  studentPage = 1;
  const q = document.getElementById('student-search').value.trim().toLowerCase();
  studentCache = allStudentCache.filter(r => r.enrollment_status === studentStatusTab);
  const filtered = q
    ? studentCache.filter(r => r.full_name.toLowerCase().includes(q) || r.admission_number.toLowerCase().includes(q))
    : studentCache;
  renderStudentTable(filtered);
}

let studentEditContext = null; // student id currently being edited, or null when adding

function renderStudentTable(rows) {
  const { pageRows } = paginate(rows, studentPage, 'student-pagination', (p) => { studentPage = p; renderStudentTable(rows); });
  const tbody = document.getElementById('student-table-body');
  const emptyMessage = studentStatusTab === 'withdrawn' ? 'No withdrawn students.' : 'No students yet — add one above.';
  if (rows.length === 0) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="6">${emptyMessage}</td></tr>`;
    return;
  }

  tbody.innerHTML = pageRows.map(r => {
    const fourthCell = studentStatusTab === 'withdrawn'
      ? escapeHtml(r.withdrawn_at ? new Date(r.withdrawn_at).toLocaleDateString() : '—')
      : escapeHtml(r.class_arm);
    const actions = studentStatusTab === 'withdrawn'
      ? `<button type="button" class="icon-btn" data-reinstate="${r.id}">Reinstate</button>`
      : `<button type="button" class="icon-btn" data-edit-student="${r.id}">Edit</button>
         <button type="button" class="icon-btn" data-transfer="${r.id}">Transfer</button>
         <button type="button" class="icon-btn icon-btn-danger" data-withdraw="${r.id}">Withdraw</button>`;
    return `
    <tr>
      <td>${escapeHtml(r.admission_number)}</td>
      <td>${escapeHtml(r.full_name)}</td>
      <td>${escapeHtml(r.gender || '—')}</td>
      <td>${fourthCell}</td>
      <td>${escapeHtml(r.display_parent_name)}${r.parent_id ? ' <span class="badge badge-success">Linked</span>' : ''}</td>
      <td>${actions}</td>
    </tr>`;
  }).join('');

  tbody.querySelectorAll('[data-edit-student]').forEach(btn => {
    btn.addEventListener('click', () => {
      const row = studentCache.find(r => r.id === btn.dataset.editStudent);
      if (row) openStudentEditForm(row);
    });
  });

  tbody.querySelectorAll('[data-transfer]').forEach(btn => {
    btn.addEventListener('click', () => openTransferPrompt(btn.dataset.transfer));
  });

  tbody.querySelectorAll('[data-withdraw]').forEach(btn => {
    btn.addEventListener('click', () => withdrawStudent(btn.dataset.withdraw));
  });

  tbody.querySelectorAll('[data-reinstate]').forEach(btn => {
    btn.addEventListener('click', () => reinstateStudent(btn.dataset.reinstate));
  });
}

function openStudentEditForm(row) {
  studentEditContext = row.id;
  document.getElementById('student-admission-number').value = row.admission_number || '';
  document.getElementById('student-full-name').value = row.full_name || '';
  document.getElementById('student-gender').value = row.gender || 'Male';
  document.getElementById('student-dob').value = row.date_of_birth || '';
  document.getElementById('student-parent-name').value = row.parent_name || '';
  document.getElementById('student-parent-phone').value = row.parent_phone || '';
  document.getElementById('student-parent-contact-email').value = row.parent_contact_email || '';
  document.getElementById('student-existing-parent-email').value = row.linked_parent_email || '';
  document.getElementById('student-passport-file').value = '';

  document.getElementById('student-class-group').classList.add('hidden');
  document.getElementById('student-form-edit-note').classList.remove('hidden');
  document.getElementById('student-form-heading').textContent = 'Edit student';
  document.getElementById('student-form-submit').textContent = 'Save changes';
  toggleInlineForm('student-form-card', true);
}

function resetStudentForm() {
  studentEditContext = null;
  document.getElementById('student-form').reset();
  document.getElementById('student-class-group').classList.remove('hidden');
  document.getElementById('student-form-edit-note').classList.add('hidden');
  document.getElementById('student-form-heading').textContent = 'Add student';
  document.getElementById('student-form-submit').textContent = 'Register student';
}

async function openTransferPrompt(studentId) {
  if (!appState.activeTermId) { showToast('No active term set.', 'error'); return; }
  await refreshClassesWithArmsCache();
  const options = classesWithArmsCache.map(c => `${c.name} → id:${c.id}`).join('\n');
  const classId = prompt(`Transfer to which class? Enter the class's ID from this list:\n\n${options}`);
  if (!classId) return;
  const targetClass = classesWithArmsCache.find(c => c.id === classId.trim());
  if (!targetClass || !targetClass.arms[0]) { showToast('Class ID not recognized — copy it exactly from the list.', 'error'); return; }
  const targetArm = targetClass.arms[0];

  showLoading();
  try {
    const { data: enrollment, error: fetchErr } = await supabaseClient
      .from('enrollments').select('id, class_id, arm_id').eq('student_id', studentId).eq('term_id', appState.activeTermId).single();
    if (fetchErr) throw fetchErr;

    const { error: transferErr } = await supabaseClient.from('transfers').insert({
      student_id: studentId,
      from_class_id: enrollment.class_id,
      from_arm_id: enrollment.arm_id,
      to_class_id: targetClass.id,
      to_arm_id: targetArm.id,
      transferred_by: appState.user.id,
    });
    if (transferErr) throw transferErr;

    const { error: updateErr } = await supabaseClient
      .from('enrollments').update({ class_id: targetClass.id, arm_id: targetArm.id, status: 'transferred' }).eq('id', enrollment.id);
    if (updateErr) throw updateErr;

    showToast('Student transferred.', 'success');
    loadStudentsScreen();
  } catch (err) {
    showToast(err.message || 'Could not transfer student.', 'error');
  } finally {
    hideLoading();
  }
}

/* ----------------------------------------------------------------------------
   15b. WITHDRAW / REINSTATE STUDENTS
   A student who suddenly leaves the school moves to enrollment_status =
   'withdrawn' rather than being deleted: their current-term enrollment row
   (and every past result/report card that hangs off it) is kept, just
   flagged, so they're invisible to the day-to-day screens (My Class, Enter
   Results, Report Cards, Promotions) but fully restorable. If this was
   their parent's only active child, the parent's login is switched off too
   — and switched back on automatically on Reinstate, but only if THIS
   withdrawal is what turned it off (students.parent_auto_deactivated), so
   an admin's own unrelated deactivation of that parent is never overridden.
   ---------------------------------------------------------------------------- */
async function countOtherActiveChildren(parentId, excludingStudentId) {
  if (!parentId) return 0;
  const { count } = await supabaseClient
    .from('students')
    .select('id', { count: 'exact', head: true })
    .eq('parent_id', parentId)
    .eq('enrollment_status', 'active')
    .neq('id', excludingStudentId);
  return count || 0;
}

async function withdrawStudent(studentId) {
  const student = allStudentCache.find(s => s.id === studentId);
  if (!student) return;

  if (!await showConfirmDialog(`They'll move to the Withdrawn tab and disappear from class rosters, results entry, report cards, and promotions — but every past record is kept and they can be reinstated anytime.`, { title: `Withdraw ${student.full_name}?`, confirmLabel: 'Withdraw', danger: true })) return;

  showLoading();
  try {
    const { error: studentErr } = await supabaseClient
      .from('students')
      .update({ enrollment_status: 'withdrawn', withdrawn_at: new Date().toISOString() })
      .eq('id', studentId);
    if (studentErr) throw studentErr;

    // Flag (not delete) their current-term enrollment, if they have one —
    // keeps every result/report card linked to it intact.
    if (appState.activeTermId) {
      await supabaseClient
        .from('enrollments')
        .update({ status: 'withdrawn' })
        .eq('student_id', studentId)
        .eq('term_id', appState.activeTermId);
    }

    let parentNote = '';
    if (student.parent_id) {
      const remaining = await countOtherActiveChildren(student.parent_id, studentId);
      if (remaining === 0) {
        const { error: userErr } = await supabaseClient
          .from('users').update({ is_active: false }).eq('id', student.parent_id);
        if (!userErr) {
          await supabaseClient.from('students').update({ parent_auto_deactivated: true }).eq('id', studentId);
          parentNote = " Their parent's login has also been deactivated (no other active children) — it'll switch back on if this student is reinstated.";
        }
      }
    }

    showToast(`${student.full_name} withdrawn.${parentNote}`, 'success');
    loadStudentsScreen();
  } catch (err) {
    showToast(err.message || 'Could not withdraw student.', 'error');
  } finally {
    hideLoading();
  }
}

async function reinstateStudent(studentId) {
  const student = allStudentCache.find(s => s.id === studentId);
  if (!student) return;

  if (!appState.activeSessionId || !appState.activeTermId) {
    showToast('No active academic session/term is set — set one in Settings before reinstating students.', 'error');
    return;
  }
  if (!await showConfirmDialog(`They'll move back to Active and reappear on class rosters and results entry.`, { title: `Reinstate ${student.full_name}?`, confirmLabel: 'Reinstate' })) return;

  showLoading();
  try {
    // If they already have a row for the current term (most common case —
    // withdrawn this same term), just flip it back to active in place.
    const { data: existingEnrollment } = await supabaseClient
      .from('enrollments').select('id, status')
      .eq('student_id', studentId).eq('term_id', appState.activeTermId).maybeSingle();

    if (existingEnrollment) {
      if (existingEnrollment.status === 'withdrawn') {
        await supabaseClient.from('enrollments').update({ status: 'active' }).eq('id', existingEnrollment.id);
      }
    } else {
      // No enrollment for the current term (withdrawn a session or more
      // ago) — need a class to put them back into, same as adding a new
      // student.
      await refreshClassesWithArmsCache();
      if (classesWithArmsCache.length === 0) throw new Error('No classes exist yet — add one under Classes & Subjects first.');
      const options = classesWithArmsCache.map(c => `${c.name} → id:${c.id}`).join('\n');
      const classId = prompt(`${student.full_name} has no enrollment for the current term. Which class should they rejoin? Enter the class's ID from this list:\n\n${options}`);
      if (!classId) { hideLoading(); return; }
      const targetClass = classesWithArmsCache.find(c => c.id === classId.trim());
      if (!targetClass || !targetClass.arms[0]) throw new Error("Class ID not recognized — copy it exactly from the list. They're still withdrawn; try Reinstate again.");

      const { error: enrollErr } = await supabaseClient.from('enrollments').insert({
        student_id: studentId,
        session_id: appState.activeSessionId,
        term_id: appState.activeTermId,
        class_id: targetClass.id,
        arm_id: targetClass.arms[0].id,
        status: 'active',
      });
      if (enrollErr) throw enrollErr;
    }

    const { error: studentErr } = await supabaseClient
      .from('students')
      .update({ enrollment_status: 'active', withdrawn_at: null })
      .eq('id', studentId);
    if (studentErr) throw studentErr;

    let parentNote = '';
    if (student.parent_id && student.parent_auto_deactivated) {
      await supabaseClient.from('users').update({ is_active: true }).eq('id', student.parent_id);
      await supabaseClient.from('students').update({ parent_auto_deactivated: false }).eq('id', studentId);
      parentNote = " Their parent's login has been reactivated.";
    }

    showToast(`${student.full_name} reinstated.${parentNote}`, 'success');
    loadStudentsScreen();
  } catch (err) {
    showToast(err.message || 'Could not reinstate student.', 'error');
  } finally {
    hideLoading();
  }
}

// Part 3 of the parent self-registration spec: an admission list the school
// can hand to parents (WhatsApp, email, printed) so they have the admission
// number they'll need to self-register — CSV and print need no library;
// .xlsx uses the SheetJS CDN script tag added in index.html.
function exportAdmissionList(format) {
  const rows = studentCache.map(s => ({
    'Admission Number': s.admission_number,
    'Student Name': s.full_name,
    'Class': s.class_arm,
    'Parent Name': s.parent_name || '',
    'Parent Phone': s.parent_phone || '',
  }));
  if (rows.length === 0) { showToast('No students to export yet.', 'error'); return; }

  const filenameBase = `admission-list-${new Date().toISOString().slice(0, 10)}`;

  if (format === 'csv') {
    const headers = Object.keys(rows[0]);
    const csvEscape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = [headers.join(','), ...rows.map(r => headers.map(h => csvEscape(r[h])).join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${filenameBase}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  } else if (format === 'xlsx') {
    if (typeof XLSX === 'undefined') { showToast('Excel export library failed to load — try CSV instead.', 'error'); return; }
    const sheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, 'Admission List');
    XLSX.writeFile(workbook, `${filenameBase}.xlsx`);
  } else if (format === 'print') {
    const win = window.open('', '_blank');
    const tableRows = rows.map(r => `<tr><td>${escapeHtml(r['Admission Number'])}</td><td>${escapeHtml(r['Student Name'])}</td><td>${escapeHtml(r['Class'])}</td><td>${escapeHtml(r['Parent Name'])}</td><td>${escapeHtml(r['Parent Phone'])}</td></tr>`).join('');
    win.document.write(`
      <html><head><title>Admission List</title>
      <style>
        body { font-family: Arial, sans-serif; padding: 24px; }
        h1 { font-size: 18px; }
        table { width: 100%; border-collapse: collapse; margin-top: 16px; }
        th, td { border: 1px solid #ccc; padding: 6px 10px; text-align: left; font-size: 13px; }
        th { background: #f0f0f0; }
      </style></head>
      <body>
        <h1>${escapeHtml(appState.schoolSettings?.school_name || 'School')} — Admission List</h1>
        <table><thead><tr><th>Admission Number</th><th>Student Name</th><th>Class</th><th>Parent Name</th><th>Parent Phone</th></tr></thead>
        <tbody>${tableRows}</tbody></table>
      </body></html>
    `);
    win.document.close();
    win.focus();
    win.print();
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('student-add-btn').addEventListener('click', () => {
    resetStudentForm();
    toggleInlineForm('student-form-card', true);
  });
  document.getElementById('student-export-btn').addEventListener('click', () => {
    document.getElementById('student-export-menu').classList.toggle('hidden');
  });
  document.querySelectorAll('#student-export-menu [data-export-format]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.getElementById('student-export-menu').classList.add('hidden');
      exportAdmissionList(btn.dataset.exportFormat);
    });
  });
  document.getElementById('student-form-cancel').addEventListener('click', () => {
    resetStudentForm();
    toggleInlineForm('student-form-card', false);
  });
  document.getElementById('student-search').addEventListener('input', () => applyStudentTabFilter());
  document.querySelectorAll('#student-status-tabs [data-student-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      studentStatusTab = btn.dataset.studentTab;
      toggleInlineForm('student-form-card', false);
      applyStudentTabFilter();
    });
  });
  document.getElementById('student-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('student-form-error');
    errorEl.classList.add('hidden');

    if (!studentEditContext && (!appState.activeSessionId || !appState.activeTermId)) {
      errorEl.textContent = 'No active academic session/term is set. Complete the Setup Wizard (or set one in Settings) before enrolling students.';
      errorEl.classList.remove('hidden');
      return;
    }

    showLoading();
    try {
      // Only touched if the admin explicitly enters an already-registered
      // parent's email here — otherwise an existing link (most commonly set
      // by the parent's own self-registration) is left completely alone.
      const existingParentEmail = document.getElementById('student-existing-parent-email').value.trim();
      let parentIdOverride; // undefined = don't touch; null/string = set explicitly
      let linkedParentProfile = null; // { full_name, phone, email } of the parent just linked, if any
      if (existingParentEmail) {
        const { data: parentUser } = await supabaseClient
          .from('users').select('id, full_name, phone, email').eq('email', existingParentEmail).eq('role', 'parent').maybeSingle();
        if (parentUser) {
          parentIdOverride = parentUser.id;
          linkedParentProfile = parentUser;
        } else {
          showToast('No parent found with that email — student saved without linking to that account.', 'error');
        }
      }

      // If the admin left a contact field blank, and we just linked a parent
      // account, fill the gap from that parent's own profile — e.g. the
      // admin didn't have a phone number on hand, but the parent's account
      // already has one. Anything the admin actually typed always wins.
      const parentName = document.getElementById('student-parent-name').value.trim()
        || (linkedParentProfile ? (linkedParentProfile.full_name || '') : '');
      const parentPhone = document.getElementById('student-parent-phone').value.trim()
        || (linkedParentProfile ? (linkedParentProfile.phone || '') : '');
      const parentContactEmail = document.getElementById('student-parent-contact-email').value.trim()
        || (linkedParentProfile ? (linkedParentProfile.email || '') : '');
      const passportFile = document.getElementById('student-passport-file').files[0];

      if (studentEditContext) {
        // Editing an existing student — class/enrollment untouched (use Transfer for that)
        const updatePayload = {
          full_name: document.getElementById('student-full-name').value.trim(),
          gender: document.getElementById('student-gender').value,
          date_of_birth: document.getElementById('student-dob').value || null,
          parent_name: parentName || null,
          parent_phone: parentPhone || null,
          parent_email: parentContactEmail || null,
        };
        if (parentIdOverride !== undefined) updatePayload.parent_id = parentIdOverride;
        if (passportFile) {
          const passportUrl = await uploadSchoolAsset(passportFile, 'passports');
          if (passportUrl) updatePayload.passport_url = passportUrl;
        }
        const { error: updateErr } = await supabaseClient.from('students').update(updatePayload).eq('id', studentEditContext);
        if (updateErr) throw updateErr;

        showToast('Student details updated.', 'success');
      } else {
        // Adding a new student — admission_number is left out entirely so the
        // database trigger generates it (PS<year><00001>); it's never typed
        // in by hand.
        const passportUrl = await uploadSchoolAsset(passportFile, 'passports');

        const { data: student, error: studentErr } = await supabaseClient
          .from('students')
          .insert({
            full_name: document.getElementById('student-full-name').value.trim(),
            gender: document.getElementById('student-gender').value,
            date_of_birth: document.getElementById('student-dob').value || null,
            passport_url: passportUrl,
            parent_name: parentName || null,
            parent_phone: parentPhone || null,
            parent_email: parentContactEmail || null,
            parent_id: parentIdOverride || null,
          })
          .select()
          .single();
        if (studentErr) throw studentErr;

        const selectedClassId = document.getElementById('student-class').value;
        const selectedClass = classesWithArmsCache.find(c => c.id === selectedClassId);
        if (!selectedClass || !selectedClass.arms[0]) throw new Error('That class has no arm set up yet — contact support.');

        const { error: enrollErr } = await supabaseClient.from('enrollments').insert({
          student_id: student.id,
          session_id: appState.activeSessionId,
          term_id: appState.activeTermId,
          class_id: selectedClassId,
          arm_id: selectedClass.arms[0].id,
          status: 'active',
        });
        if (enrollErr) throw enrollErr;

        showToast(`Student registered — admission number ${student.admission_number}. Share this with the parent (see Export admission list).`, 'success');
      }

      resetStudentForm();
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
    container.innerHTML = `<div class="card card-notice"><p>You have not been assigned to a class yet. Ask your administrator to assign you under Classes &amp; Subjects.</p></div>`;
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
      .eq('term_id', appState.activeTermId)
      .neq('status', 'withdrawn');

    html += `
      <div class="card">
        <h2 class="card-title">${escapeHtml(arm.classes.name)} — ${(enrollments || []).length} student(s)</h2>
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
    notice.innerHTML = `<div class="card card-notice"><p>You have not been assigned to a class yet. Ask your administrator to assign you under Classes &amp; Subjects.</p></div>`;
    armSelect.innerHTML = '';
    subjectSelect.innerHTML = '';
    return;
  }
  armSelect.innerHTML = arms.map(a => `<option value="${a.id}">${escapeHtml(a.classes.name)}</option>`).join('');
  resultsScreenState.armId = arms[0].id;

  if (!appState.activeTermId) {
    notice.innerHTML = `<div class="card card-notice"><p>No active academic term is set. Ask your administrator to complete setup.</p></div>`;
    return;
  }

  const { data: term } = await supabaseClient.from('terms').select('is_result_entry_open').eq('id', appState.activeTermId).single();
  resultsScreenState.termOpen = !!(term && term.is_result_entry_open);

  await populateResultsSubjectSelect(resultsScreenState.armId);
  await renderResultsEntryTable();
  await renderResultsClassBar();
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

async function getClassDraftResultIds(armId) {
  const { data: enrollments } = await supabaseClient
    .from('enrollments')
    .select('id')
    .eq('arm_id', armId)
    .eq('term_id', appState.activeTermId)
    .neq('status', 'withdrawn');
  const enrollmentIds = (enrollments || []).map(e => e.id);
  if (enrollmentIds.length === 0) return [];

  // A "draft" row in the DB always has both CA and Exam scores set — see
  // saveAllResultsAsDraft's comment above — so unlike the per-subject
  // submit button (which checks the on-screen table), these are already
  // known-complete and can be submitted straight from the database.
  const { data: results } = await supabaseClient
    .from('results')
    .select('id')
    .eq('term_id', appState.activeTermId)
    .eq('status', 'draft')
    .in('enrollment_id', enrollmentIds);
  return (results || []).map(r => r.id);
}

// Class-wide "submit all drafts" — lets a teacher clear every subject's
// draft scores for the selected class in one action, instead of switching
// the Subject dropdown and clicking "Submit all drafts" once per subject.
async function renderResultsClassBar() {
  const bar = document.getElementById('results-class-bar');
  if (!bar || !resultsScreenState.armId || !resultsScreenState.termOpen) {
    if (bar) bar.innerHTML = '';
    return;
  }

  const arm = (await getTeacherArms()).find(a => a.id === resultsScreenState.armId);
  const className = arm ? arm.classes.name : 'this class';
  const draftIds = await getClassDraftResultIds(resultsScreenState.armId);

  if (draftIds.length === 0) {
    bar.innerHTML = '';
    return;
  }

  bar.innerHTML = `
    <div class="table-toolbar" style="margin-top: 12px;">
      <span class="view-subheading">${draftIds.length} draft result(s) ready across all subjects for ${escapeHtml(className)}</span>
      <button type="button" class="btn btn-primary" id="submit-all-class-btn">Submit all drafts for this class</button>
    </div>
  `;
  document.getElementById('submit-all-class-btn').addEventListener('click', async () => {
    if (!await showConfirmDialog(`This submits all ${draftIds.length} draft result(s) across every subject for ${className}. You won't be able to edit them until an admin reviews.`, { title: 'Submit for admin approval?', confirmLabel: 'Submit for approval' })) return;
    showLoading();
    try {
      const { error } = await supabaseClient
        .from('results').update({ status: 'submitted' })
        .in('id', draftIds).eq('status', 'draft');
      if (error) throw error;
      showToast(`${draftIds.length} result(s) submitted for approval.`, 'success');
      renderResultsEntryTable();
      renderResultsClassBar();
      notifyAdminsResultsSubmittedForClass(className, draftIds.length);
    } catch (err) {
      showToast(err.message || 'Could not submit.', 'error');
    } finally {
      hideLoading();
    }
  });
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
    .eq('term_id', appState.activeTermId)
    .neq('status', 'withdrawn');

  if (!enrollments || enrollments.length === 0) {
    notice.innerHTML = `<div class="card card-notice"><p>No students enrolled in this class for the current term yet.</p></div>`;
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

    const initials = e.students.full_name
      .split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase();

    return `
      <tr data-enrollment-id="${e.id}" data-student-id="${e.student_id}">
        <td>
          <div class="student-cell">
            <span class="student-avatar">${initials}</span>
            <div>
              <div class="student-name">${escapeHtml(e.students.full_name)}</div>
              ${status === 'rejected' && r.rejection_reason ? `<div class="rejection-note">Rejected: ${escapeHtml(r.rejection_reason)}</div>` : ''}
            </div>
          </div>
        </td>
        <td class="col-score"><input class="score-input" type="number" min="0" max="40" data-field="ca" placeholder="—" value="${caVal}" ${editable ? '' : 'disabled'}></td>
        <td class="col-score"><input class="score-input" type="number" min="0" max="60" data-field="exam" placeholder="—" value="${examVal}" ${editable ? '' : 'disabled'}></td>
        <td class="col-total row-total">${totalVal}</td>
        <td class="col-status"><span class="badge ${badgeClass}">${badgeLabel}</span></td>
        <td class="col-actions row-actions">
          ${status === 'rejected' ? `<button type="button" class="icon-btn" data-reopen="${e.id}">Reopen</button>` : ''}
          ${editable ? `<button type="button" class="icon-btn icon-btn-save" data-save-row="${e.id}">Save</button>` : ''}
        </td>
      </tr>`;
  }).join('');

  wireResultsRowActions();
}

function wireResultsRowActions() {
  const allInputs = [];
  document.querySelectorAll('#results-entry-body tr').forEach(row => {
    const caInput = row.querySelector('[data-field="ca"]');
    const examInput = row.querySelector('[data-field="exam"]');
    const totalCell = row.querySelector('.row-total');
    const recalc = () => {
      const ca = parseFloat(caInput.value) || 0;
      const exam = parseFloat(examInput.value) || 0;
      if (caInput.value !== '' || examInput.value !== '') totalCell.textContent = (ca + exam).toFixed(0) + ' (preview)';
    };
    if (caInput && !caInput.disabled) { caInput.addEventListener('input', recalc); allInputs.push(caInput); }
    if (examInput && !examInput.disabled) { examInput.addEventListener('input', recalc); allInputs.push(examInput); }
  });

  // Enter key jumps to the next editable score box instead of submitting
  // anything, so a teacher can keyboard through the whole class quickly:
  // CA → Exam → next student's CA → ...
  allInputs.forEach((input, i) => {
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const next = allInputs[i + 1];
      if (next) next.focus();
      else document.getElementById('results-save-all-btn')?.focus();
    });
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

// Lets a teacher fill in every student's scores first, then save the whole
// class in one action instead of clicking "Save" per row. Rows left
// completely blank are skipped (so a teacher can partially fill a class and
// come back later); a row with only ONE of the two scores filled in is
// treated as a mistake and blocks the whole save with a clear message,
// since a half-entered score is more likely a typo than an intentional
// partial save. Only rows still in "draft" (editable) are considered —
// submitted/approved/rejected rows are untouched.
async function saveAllResultsAsDraft() {
  const rows = Array.from(document.querySelectorAll('#results-entry-body tr'));
  const editableRows = rows.filter(row => {
    const caInput = row.querySelector('[data-field="ca"]');
    return caInput && !caInput.disabled;
  });

  if (editableRows.length === 0) {
    showToast('Nothing here is currently editable.', 'error');
    return;
  }

  const toSave = [];
  const partial = [];
  const outOfRange = [];

  editableRows.forEach(row => {
    const caVal = row.querySelector('[data-field="ca"]').value;
    const examVal = row.querySelector('[data-field="exam"]').value;
    const studentName = row.querySelector('.student-name').textContent.trim();

    if (caVal === '' && examVal === '') return; // untouched row — skip silently
    if (caVal === '' || examVal === '') {
      partial.push(studentName);
      return;
    }
    const ca = Number(caVal), exam = Number(examVal);
    if (ca < 0 || ca > 40 || exam < 0 || exam > 60) {
      outOfRange.push(studentName);
      return;
    }
    toSave.push({
      enrollment_id: row.dataset.enrollmentId,
      student_id: row.dataset.studentId,
      subject_id: resultsScreenState.subjectId,
      term_id: appState.activeTermId,
      ca_score: ca,
      exam_score: exam,
      status: 'draft',
      entered_by: appState.user.id,
    });
  });

  if (partial.length > 0) {
    showToast(`${partial.length} student(s) have only one score filled in — ${partial.join(', ')}. Fill both CA and Exam (or leave both blank) before saving.`, 'error');
    return;
  }
  if (outOfRange.length > 0) {
    showToast(`${outOfRange.length} student(s) have an out-of-range score — ${outOfRange.join(', ')}. CA must be 0–40 and Exam must be 0–60.`, 'error');
    return;
  }
  if (toSave.length === 0) {
    showToast('No scores entered yet.', 'error');
    return;
  }

  showLoading();
  try {
    const { error } = await supabaseClient
      .from('results')
      .upsert(toSave, { onConflict: 'enrollment_id,subject_id' });
    if (error) throw error;
    showToast(`Saved ${toSave.length} student score(s) as draft.`, 'success');
    renderResultsEntryTable();
    renderResultsClassBar();
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
    renderResultsClassBar();
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
    renderResultsClassBar();
  });
  document.getElementById('results-subject-select').addEventListener('change', (e) => {
    resultsScreenState.subjectId = e.target.value;
    renderResultsEntryTable();
  });

  document.getElementById('results-save-all-btn').addEventListener('click', saveAllResultsAsDraft);

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

    if (!await showConfirmDialog(`This submits ${draftRows.length} result(s) for admin approval. You won't be able to edit them until an admin reviews.`, { title: 'Submit for admin approval?', confirmLabel: 'Submit for approval' })) return;

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
      notifyAdminsResultsSubmitted(draftRows.length);
      renderResultsEntryTable();
      renderResultsClassBar();
    } catch (err) {
      showToast(err.message || 'Could not submit.', 'error');
    } finally {
      hideLoading();
    }
  });
});

// Emails every active admin when a teacher submits results for approval,
// so admins don't have to keep checking the Result Approvals screen —
// each email names the specific class + subject that's now waiting.
// notification_emails() is a SECURITY DEFINER Supabase function (see
// supabase-notifications.sql) since a teacher's own session can't
// otherwise read other users' emails.
async function notifyAdminsResultsSubmitted(count) {
  try {
    const arm = (await getTeacherArms()).find(a => a.id === resultsScreenState.armId);
    const subjectOption = document.getElementById('results-subject-select').selectedOptions[0];
    const subjectName = subjectOption ? subjectOption.textContent : 'a subject';
    const className = arm ? arm.classes.name : 'a class';

    const { data: admins } = await supabaseClient.rpc('notification_emails', { p_role: 'admin' });
    const recipients = (admins || []).map(a => a.email).filter(Boolean);
    if (recipients.length === 0) return;

    sendAppsScriptBulkEmail({
      recipients,
      subject: `Results submitted for approval — ${className} · ${subjectName}`,
      body: `${appState.user.full_name} has submitted ${count} result(s) for ${className} · ${subjectName} for your approval.\n\nGo to Result Approvals in your dashboard to review.\n\n— ${appState.schoolSettings?.school_name || 'The school'}`,
    });
  } catch (err) {
    console.warn('Could not notify admins of submitted results:', err);
  }
}

// Class-wide variant of notifyAdminsResultsSubmitted, fired by "Submit all
// drafts for this class" — the message doesn't name one subject since the
// submission spans every subject with drafts ready for this class.
async function notifyAdminsResultsSubmittedForClass(className, count) {
  try {
    const { data: admins } = await supabaseClient.rpc('notification_emails', { p_role: 'admin' });
    const recipients = (admins || []).map(a => a.email).filter(Boolean);
    if (recipients.length === 0) return;

    sendAppsScriptBulkEmail({
      recipients,
      subject: `Results submitted for approval — ${className}`,
      body: `${appState.user.full_name} has submitted ${count} result(s) across multiple subjects for ${className} for your approval.\n\nGo to Result Approvals in your dashboard to review.\n\n— ${appState.schoolSettings?.school_name || 'The school'}`,
    });
  } catch (err) {
    console.warn('Could not notify admins of submitted results:', err);
  }
}

/* ----------------------------------------------------------------------------
   18. ADMIN — RESULT APPROVALS
   ---------------------------------------------------------------------------- */
async function getArmTeacherContact(armId) {
  const arm = classesWithArmsCache.flatMap(c => c.arms).find(a => a.id === armId);
  const teacherId = arm && arm.class_teacher_id;
  if (!teacherId) return null;
  const { data: teacherStaff } = await supabaseClient.from('staff').select('users(full_name, email)').eq('id', teacherId).single();
  return teacherStaff && teacherStaff.users ? teacherStaff.users : null;
}

let approvalsState = { armId: null, subjectId: null };

async function loadApprovalsScreen() {
  const container = document.getElementById('approvals-content');
  await refreshClassesWithArmsCache();

  const allArms = classesWithArmsCache.flatMap(c => c.arms.map(a => ({ ...a, className: c.name })));
  if (allArms.length === 0) {
    container.innerHTML = `<div class="card card-notice"><p>No classes exist yet. Add them under Classes &amp; Subjects first.</p></div>`;
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
          <label class="field-label">Class</label>
          <select class="field-input" id="approvals-arm-select">
            ${allArms.map(a => `<option value="${a.id}" ${a.id === approvalsState.armId ? 'selected' : ''}>${escapeHtml(a.className)}</option>`).join('')}
          </select>
        </div>
        <div>
          <label class="field-label">Subject</label>
          <select class="field-input" id="approvals-subject-select"></select>
        </div>
      </div>
      <div id="approvals-class-bar"></div>
    </div>
    <div id="approvals-table-wrap"></div>
  `;

  document.getElementById('approvals-arm-select').addEventListener('change', async (e) => {
    approvalsState.armId = e.target.value;
    await populateApprovalsSubjectSelect();
    renderApprovalsTable();
    renderApprovalsClassBar();
  });
  document.getElementById('approvals-subject-select').addEventListener('change', (e) => {
    approvalsState.subjectId = e.target.value;
    renderApprovalsTable();
  });

  await populateApprovalsSubjectSelect();
  renderApprovalsTable();
  renderApprovalsClassBar();
}

/* ----------------------------------------------------------------------------
   Class-wide "approve all pending" — lets an admin clear every subject's
   pending results for the selected class in one action, instead of having
   to switch the Subject dropdown and click "Approve all shown" once per
   subject. Independent of the subject filter above: it always looks at
   every submitted result for the whole class in the active term.
   ---------------------------------------------------------------------------- */
async function getClassPendingResultIds(armId) {
  const { data: enrollments } = await supabaseClient
    .from('enrollments')
    .select('id')
    .eq('arm_id', armId)
    .eq('term_id', appState.activeTermId)
    .neq('status', 'withdrawn');
  const enrollmentIds = (enrollments || []).map(e => e.id);
  if (enrollmentIds.length === 0) return [];

  const { data: results } = await supabaseClient
    .from('results')
    .select('id')
    .eq('term_id', appState.activeTermId)
    .eq('status', 'submitted')
    .in('enrollment_id', enrollmentIds);
  return (results || []).map(r => r.id);
}

async function renderApprovalsClassBar() {
  const bar = document.getElementById('approvals-class-bar');
  if (!bar || !approvalsState.armId) return;

  const arm = classesWithArmsCache.flatMap(c => c.arms.map(a => ({ ...a, className: c.name }))).find(a => a.id === approvalsState.armId);
  const className = arm ? arm.className : 'this class';
  const pendingIds = await getClassPendingResultIds(approvalsState.armId);

  if (pendingIds.length === 0) {
    bar.innerHTML = '';
    return;
  }

  bar.innerHTML = `
    <div class="table-toolbar" style="margin-top: 12px;">
      <span class="view-subheading">${pendingIds.length} result(s) pending across all subjects for ${escapeHtml(className)}</span>
      <button type="button" class="btn btn-primary" id="approve-all-class-btn">Approve all pending for this class</button>
    </div>
  `;
  document.getElementById('approve-all-class-btn').addEventListener('click', async () => {
    if (!await showConfirmDialog(`This approves all ${pendingIds.length} pending result(s) across every subject for ${className}.`, { title: 'Approve all pending results?', confirmLabel: 'Approve all' })) return;
    showLoading();
    try {
      const { error } = await supabaseClient
        .from('results').update({ status: 'approved' })
        .in('id', pendingIds).eq('status', 'submitted');
      if (error) throw error;
      showToast(`${pendingIds.length} result(s) approved for ${className}.`, 'success');
      renderApprovalsTable();
      renderApprovalsClassBar();

      getArmTeacherContact(approvalsState.armId).then(teacher => {
        if (!teacher || !teacher.email) return;
        sendAppsScriptEmail({
          to: teacher.email,
          subject: `Results approved — ${className}`,
          body: `Hello ${teacher.full_name},\n\nYour submitted results for ${className} (${pendingIds.length} result(s) across all subjects) have been reviewed and approved.\n\nNo further action is needed — they're now part of the students' report cards.\n\n— ${appState.schoolSettings?.school_name || 'The school'}`,
        });
      });
    } catch (err) {
      showToast(err.message || 'Could not approve.', 'error');
    } finally {
      hideLoading();
    }
  });
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
    .eq('term_id', appState.activeTermId)
    .neq('status', 'withdrawn');

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
    wrap.innerHTML = `<div class="card card-notice"><p>No results awaiting approval for this class/subject right now.</p></div>`;
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
    if (!await showConfirmDialog(`This approves all ${submitted.length} submitted result(s) shown.`, { title: 'Approve all shown results?', confirmLabel: 'Approve all' })) return;
    showLoading();
    try {
      const { error } = await supabaseClient
        .from('results').update({ status: 'approved' })
        .in('id', submitted.map(r => r.id)).eq('status', 'submitted');
      if (error) throw error;
      showToast('All shown results approved.', 'success');
      renderApprovalsTable();
      renderApprovalsClassBar();

      const arm = classesWithArmsCache.flatMap(c => c.arms.map(a => ({ ...a, className: c.name }))).find(a => a.id === approvalsState.armId);
      const subjectOption = document.getElementById('approvals-subject-select').selectedOptions[0];
      const subjectName = subjectOption ? subjectOption.textContent : 'a subject';
      getArmTeacherContact(approvalsState.armId).then(teacher => {
        if (!teacher || !teacher.email) return;
        sendAppsScriptEmail({
          to: teacher.email,
          subject: `Results approved — ${arm ? arm.className : 'your class'} · ${subjectName}`,
          body: `Hello ${teacher.full_name},\n\nYour submitted results for ${arm ? arm.className : 'your class'} · ${subjectName} (${submitted.length} result(s)) have been reviewed and approved.\n\nNo further action is needed — they're now part of the students' report cards.\n\n— ${appState.schoolSettings?.school_name || 'The school'}`,
        });
      });
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
    renderApprovalsClassBar();
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
    renderApprovalsClassBar();
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
    container.innerHTML = `<div class="card card-notice"><p>No classes exist yet.</p></div>`;
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
          <label class="field-label">Class</label>
          <select class="field-input" id="reportcards-arm-select">
            ${allArms.map(a => `<option value="${a.id}" ${a.id === reportCardsArmId ? 'selected' : ''}>${escapeHtml(a.className)}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="form-actions">
        <button type="button" class="btn btn-primary" id="generate-reportcards-btn">Generate / refresh report cards for this class</button>
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
      .eq('term_id', appState.activeTermId)
      .neq('status', 'withdrawn');

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
      if (!await showConfirmDialog('The parent will be able to see it immediately.', { title: 'Publish this report card?', confirmLabel: 'Publish' })) return;
      showLoading();
      try {
        const { error } = await supabaseClient
          .from('report_cards').update({ published_at: new Date().toISOString() }).eq('id', btn.dataset.publish);
        if (error) throw error;
        showToast('Published.', 'success');
        notifyReportCardPublished(btn.dataset.publish);
        checkAndNotifyClassPublishComplete(reportCardsArmId);
        renderReportCardsTable(rows);
        checkSessionRolloverPrompt();
      } catch (err) {
        showToast(err.message || 'Could not publish.', 'error');
      } finally {
        hideLoading();
      }
    });
  });
}

// EMAIL 1 — fires on every individual publish. Notifies the class teacher
// AND every admin (never the parent — parents are only emailed once the
// whole class is done, in notifyParentsClassFullyPublished() below), with
// a direct link (?rc=<id> — see reportCardLinkURL()) that opens straight
// to it once they sign in. Fire-and-forget — sendAppsScriptBulkEmail()
// already no-ops safely if no webhook is configured.
async function notifyReportCardPublished(reportCardId) {
  const { data: card } = await supabaseClient
    .from('report_cards').select('student_id, is_annual, enrollment_id, average_score, position, class_size').eq('id', reportCardId).single();
  if (!card) return;
  const { data: student } = await supabaseClient.from('students').select('full_name').eq('id', card.student_id).single();
  if (!student) return;

  const label = card.is_annual ? 'annual report' : 'report card';
  const link = reportCardLinkURL(reportCardId);
  const schoolName = appState.schoolSettings?.school_name || 'The school';

  const recipients = [];
  let className = '—', termName = '—';

  if (card.enrollment_id) {
    const { data: enrollment } = await supabaseClient
      .from('enrollments').select('classes(name), class_arms(class_teacher_id), terms(name)').eq('id', card.enrollment_id).single();
    className = enrollment?.classes?.name || '—';
    termName = enrollment?.terms?.name || '—';
    const teacherId = enrollment?.class_arms?.class_teacher_id;
    if (teacherId) {
      const { data: teacherStaff } = await supabaseClient.from('staff').select('users(full_name, email)').eq('id', teacherId).single();
      if (teacherStaff?.users?.email) recipients.push(teacherStaff.users.email);
    }
  }

  const { data: admins } = await supabaseClient.rpc('notification_emails', { p_role: 'admin' });
  (admins || []).forEach(a => { if (a.email) recipients.push(a.email); });
  if (recipients.length === 0) return;

  sendAppsScriptBulkEmail({
    recipients,
    subject: `${student.full_name}'s ${label} has been published`,
    body: `This is to notify you that ${student.full_name}'s ${label} for ${termName} has been published and is now visible to the parent/guardian.\n\nStudent: ${student.full_name}\nClass: ${className}\nTerm: ${termName}\nAverage: ${card.average_score != null ? Number(card.average_score).toFixed(1) : '—'}\nPosition: ${card.position ? `${card.position} of ${card.class_size || '—'}` : '—'}\n\nView report card:\n${link}\n\n— ${schoolName}`,
  });
}

// Fires after every individual publish. Checks whether EVERY generated
// report card for this arm+term now has published_at set — i.e. the whole
// class is done. If so, fires Email 2 (teacher+admin class summary) and
// Email 3 (one email per parent, per child). No-ops silently if the class
// still has unpublished cards left, so this is safe to call after every
// single publish without any extra "publish all" step.
async function checkAndNotifyClassPublishComplete(armId) {
  if (!armId) return;
  try {
    const { data: enrollments } = await supabaseClient
      .from('enrollments').select('id, student_id')
      .eq('arm_id', armId).eq('term_id', appState.activeTermId);
    if (!enrollments || enrollments.length === 0) return;

    const { data: cards } = await supabaseClient
      .from('report_cards').select('id, enrollment_id, student_id, published_at')
      .eq('term_id', appState.activeTermId).eq('is_annual', false)
      .in('enrollment_id', enrollments.map(e => e.id));
    if (!cards || cards.length === 0) return;
    if (!cards.every(c => c.published_at)) return; // still cards left to publish

    const arm = classesWithArmsCache.flatMap(c => c.arms.map(a => ({ ...a, className: c.name }))).find(a => a.id === armId);
    const className = arm ? arm.className : 'the class';

    const { data: term } = appState.activeTermId
      ? await supabaseClient.from('terms').select('name').eq('id', appState.activeTermId).single() : { data: null };
    const { data: session } = appState.activeSessionId
      ? await supabaseClient.from('sessions').select('name').eq('id', appState.activeSessionId).single() : { data: null };
    const termName = term?.name || 'this term';
    const sessionName = session?.name || '';

    notifyClassFullyPublished(armId, className, termName, sessionName, cards.length);
    notifyParentsClassFullyPublished(cards, enrollments, className, termName);
  } catch (err) {
    console.warn('Could not check/notify class publish completion:', err);
  }
}

// EMAIL 2 — sent once (not per student) to the class teacher + every admin
// when the LAST report card in a class/term is published.
async function notifyClassFullyPublished(armId, className, termName, sessionName, studentCount) {
  try {
    const teacherContact = await getArmTeacherContact(armId);
    const { data: admins } = await supabaseClient.rpc('notification_emails', { p_role: 'admin' });
    const recipients = [];
    if (teacherContact?.email) recipients.push(teacherContact.email);
    (admins || []).forEach(a => { if (a.email) recipients.push(a.email); });
    if (recipients.length === 0) return;

    const publishDate = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
    const schoolName = appState.schoolSettings?.school_name || 'The school';

    sendAppsScriptBulkEmail({
      recipients,
      subject: `${className} — ${termName} Report Cards Are Now Published`,
      body: `We are pleased to inform you that all report cards for ${className} — ${termName}${sessionName ? `, ${sessionName}` : ''} — have now been finalized and published.\n\nClass: ${className}\nTerm: ${termName}\nTotal students: ${studentCount}\nDate published: ${publishDate}\n\nView the full class list from Report Cards in your dashboard.\n\n— ${schoolName} Administration`,
    });
  } catch (err) {
    console.warn('Could not notify class fully published:', err);
  }
}

// EMAIL 3 — sent individually to each parent, one email per child, once the
// whole class's report cards are published. This is the ONLY report-card
// email a parent ever receives — no email goes out to them at the point an
// individual card is published (see notifyReportCardPublished above).
async function notifyParentsClassFullyPublished(cards, enrollments, className, termName) {
  const enrollmentById = {};
  enrollments.forEach(e => { enrollmentById[e.id] = e; });
  const schoolName = appState.schoolSettings?.school_name || 'The school';

  for (const card of cards) {
    const enrollment = enrollmentById[card.enrollment_id];
    if (!enrollment) continue;
    const { data: student } = await supabaseClient.from('students').select('full_name, parent_id').eq('id', card.student_id).single();
    if (!student || !student.parent_id) continue;
    const { data: parent } = await supabaseClient.from('parents').select('users(full_name, email)').eq('id', student.parent_id).single();
    if (!parent?.users?.email) continue;

    const link = reportCardLinkURL(card.id);
    sendAppsScriptEmail({
      to: parent.users.email,
      subject: `${termName} is complete — ${student.full_name}'s report card is ready`,
      body: `Hello ${parent.users.full_name},\n\n${termName} has now concluded at ${schoolName}, and ${student.full_name}'s report card is ready to view.\n\nStudent: ${student.full_name}\nClass: ${className}\nTerm: ${termName}\n\nView report card:\n${link}\n\n— ${schoolName}`,
    });
  }
}

async function renderTeacherReportCardsScreen(container) {
  const arms = await getTeacherArms();
  if (arms.length === 0 || !appState.activeTermId) {
    container.innerHTML = `<div class="card card-notice"><p>No assigned class or active term yet.</p></div>`;
    return;
  }
  const { data: enrollments } = await supabaseClient
    .from('enrollments').select('id, students(full_name)').eq('arm_id', arms[0].id).eq('term_id', appState.activeTermId).neq('status', 'withdrawn');
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
      if (!await showConfirmDialog('The administrator will be able to publish it once you confirm.', { title: 'Confirm this report card is accurate?', confirmLabel: 'Confirm accurate' })) return;
      showLoading();
      try {
        const { error } = await supabaseClient.rpc('confirm_report_card', { card_id: btn.dataset.confirmCard });
        if (error) throw error;
        showToast('Confirmed. The administrator can now publish it.', 'success');
        notifyAdminsReportCardConfirmed(btn.dataset.confirmCard);
        loadReportCardsScreen();
      } catch (err) {
        showToast(err.message || 'Could not confirm.', 'error');
      } finally {
        hideLoading();
      }
    });
  });
}

// Emails every active admin once a teacher confirms a report card is
// accurate — the admin's cue that it's now safe to publish. Uses the same
// notification_emails() RPC as notifyAdminsResultsSubmitted() above.
async function notifyAdminsReportCardConfirmed(cardId) {
  try {
    const { data: card } = await supabaseClient.from('report_cards').select('student_id').eq('id', cardId).single();
    const { data: student } = card
      ? await supabaseClient.from('students').select('full_name').eq('id', card.student_id).single()
      : { data: null };

    const { data: admins } = await supabaseClient.rpc('notification_emails', { p_role: 'admin' });
    const recipients = (admins || []).map(a => a.email).filter(Boolean);
    if (recipients.length === 0) return;

    const studentName = student ? student.full_name : 'A student';
    sendAppsScriptBulkEmail({
      recipients,
      subject: `Ready to publish — ${studentName}'s report card`,
      body: `${appState.user.full_name} has confirmed ${studentName}'s report card is accurate and ready to publish.\n\nGo to Report Cards in your dashboard to publish it.\n\n— ${appState.schoolSettings?.school_name || 'The school'}`,
    });
  } catch (err) {
    console.warn('Could not notify admins of report card confirmation:', err);
  }
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

  // Sort by child name, then most recent term first, so a parent with
  // several children/terms gets a stable, scannable order instead of raw
  // insertion order from the query.
  const sorted = [...cards].sort((a, b) => {
    const an = (children.find(ch => ch.id === a.student_id)?.full_name || '');
    const bn = (children.find(ch => ch.id === b.student_id)?.full_name || '');
    return an.localeCompare(bn) || new Date(b.created_at || 0) - new Date(a.created_at || 0);
  });

  container.innerHTML = `<div class="rc-list">${sorted.map(c => {
    const child = children.find(ch => ch.id === c.student_id);
    const name = child ? child.full_name : 'Student';
    const initials = name.trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
    const isTopOfClass = Number(c.position) === 1;
    return `
      <div class="rc-card">
        <div class="rc-card-main">
          <div class="rc-avatar">${escapeHtml(initials)}</div>
          <div class="rc-info">
            <h3 class="rc-name">${escapeHtml(name)}</h3>
            <span class="rc-term-badge">${escapeHtml(c.terms?.name || 'Term')}${c.is_annual ? ' · Annual' : ''}</span>
          </div>
        </div>
        <div class="rc-stats">
          <div class="rc-stat">
            <span class="rc-stat-label">Average</span>
            <span class="rc-stat-value">${Number(c.average_score).toFixed(1)}</span>
          </div>
          <div class="rc-stat">
            <span class="rc-stat-label">Position</span>
            <span class="rc-stat-value">${c.position}<span class="rc-stat-of">&nbsp;of ${c.class_size}</span>${isTopOfClass ? '<span class="rc-top-badge">Top of class</span>' : ''}</span>
          </div>
        </div>
        <button type="button" class="btn btn-primary rc-view-btn" data-preview="${c.id}">View &amp; Print</button>
      </div>`;
  }).join('')}</div>`;

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
    if (appState.user.role === 'admin') {
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
    } else {
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
    if (!await showConfirmDialog('The parent will be able to see and print it immediately.', { title: 'Publish this report card?', confirmLabel: 'Publish' })) return;
    showLoading();
    try {
      const { error } = await supabaseClient
        .from('report_cards').update({ published_at: new Date().toISOString() }).eq('id', currentPreviewCardId);
      if (error) throw error;
      showToast('Published.', 'success');
      notifyReportCardPublished(currentPreviewCardId);
      const { data: publishedCard } = await supabaseClient
        .from('report_cards').select('enrollment_id').eq('id', currentPreviewCardId).single();
      if (publishedCard?.enrollment_id) {
        const { data: enr } = await supabaseClient.from('enrollments').select('arm_id').eq('id', publishedCard.enrollment_id).single();
        if (enr?.arm_id) checkAndNotifyClassPublishComplete(enr.arm_id);
      }
      closeReportCardPreview();
      loadReportCardsScreen();
      checkSessionRolloverPrompt();
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
    container.innerHTML = `<div class="card card-notice"><p>No classes exist yet.</p></div>`;
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
          <label class="field-label">Class</label>
          <select class="field-input" id="promotions-arm-select">
            ${allArms.map(a => `<option value="${a.id}" ${a.id === promotionsArmId ? 'selected' : ''}>${escapeHtml(a.className)}</option>`).join('')}
          </select>
        </div>
        <div>
          <label class="field-label">Promotion threshold (annual average ≥)</label>
          <input class="field-input" type="number" id="promotion-threshold-input" value="${appState.schoolSettings?.promotion_average_threshold ?? 40}">
        </div>
      </div>
      <div class="form-actions">
        <button type="button" class="btn btn-ghost-dark" id="save-threshold-btn">Save threshold</button>
        <button type="button" class="btn btn-primary" id="generate-annual-btn">Calculate annual averages for this class</button>
      </div>
      <p class="view-subheading" style="margin-top:10px;">Once averages are calculated below, use "Promote all" to apply the threshold automatically — students at or above it are promoted to the next class, everyone else repeats (resits) their current class. No need to decide student-by-student.</p>
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
      .eq('term_id', thirdTermId)
      .neq('status', 'withdrawn');

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

  const pendingCount = (promos || []).filter(p => p.final_status === 'pending').length;

  wrap.innerHTML = `
    <div class="table-toolbar">
      <span class="view-subheading">${pendingCount > 0 ? `${pendingCount} student(s) awaiting a decision.` : 'All calculated students already have a decision.'}</span>
      <button type="button" class="btn btn-primary" id="promote-all-btn" ${pendingCount === 0 ? 'disabled' : ''}>Promote all (apply threshold automatically)</button>
    </div>
    <table class="data-table">
      <thead><tr><th>Student</th><th>Annual Avg</th><th>Decision</th><th></th></tr></thead>
      <tbody>
        ${rows.map(r => {
          const card = (cards || []).find(c => c.id === r.thirdTermCardId);
          const promo = (promos || []).find(p => p.student_id === r.studentId);
          const decided = promo && promo.final_status !== 'pending';
          let decisionCell = '—';
          if (decided) {
            decisionCell = `<span class="badge ${promo.final_status === 'promoted' ? 'badge-success' : 'badge-gold'}">${promo.final_status === 'promoted' ? 'Promoted' : 'Repeating'}</span>`;
          } else if (promo) {
            decisionCell = `<span class="badge ${promo.recommended_status === 'promote' ? 'badge-success' : 'badge-gold'}">Will ${promo.recommended_status === 'promote' ? 'promote' : 'repeat'}</span>`;
          }
          return `
            <tr>
              <td>${escapeHtml(r.studentName)}${!r.complete ? ' <span class="badge badge-error">Incomplete</span>' : ''}</td>
              <td>${card && card.annual_average != null ? Number(card.annual_average).toFixed(1) : '—'}</td>
              <td>${decisionCell}</td>
              <td class="row-actions">${card ? `<button type="button" class="icon-btn" data-preview="${card.id}">Preview</button>` : ''}</td>
            </tr>`;
        }).join('')}
      </tbody>
    </table>
  `;

  wrap.querySelectorAll('[data-preview]').forEach(btn => {
    btn.addEventListener('click', () => openReportCardPreview(btn.dataset.preview));
  });

  const promoteAllBtn = document.getElementById('promote-all-btn');
  if (promoteAllBtn) {
    promoteAllBtn.addEventListener('click', () => promoteAllPending(rows, cards, promos, arm, allArms));
  }
}

// Applies a single promotion's decision: writes the final status, works out
// the destination class (next class in sort order, or "graduated" if this is
// the last class), and mirrors the decision onto the report card.
async function applyPromotionDecision(promo, cardId, currentClassId, decision) {
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
  }).eq('id', promo.id);
  if (promoErr) throw promoErr;

  if (cardId) {
    const { error: cardErr } = await supabaseClient.from('report_cards')
      .update({ promotion_status: decision }).eq('id', cardId);
    if (cardErr) throw cardErr;
  }

  if (newEnrollmentStatus) {
    await supabaseClient.from('students').update({ enrollment_status: newEnrollmentStatus }).eq('id', promo.student_id);
  }
}

// Replaces the old per-student "Approve promotion" / "Mark repeat" buttons
// with one automatic pass: every pending student's own recommended_status
// (already computed from their annual average vs. the saved threshold) is
// applied as-is — at/above threshold promotes to the next class, everyone
// else repeats (resits) their current class. No student-by-student review.
async function promoteAllPending(rows, cards, promos, arm, allArms) {
  const pending = (promos || []).filter(p => p.final_status === 'pending');
  if (pending.length === 0) return;

  const willPromote = pending.filter(p => p.recommended_status === 'promote').length;
  const willRepeat = pending.length - willPromote;
  if (!await showConfirmDialog(`${willPromote} will be promoted to the next class, ${willRepeat} will repeat (resit) this class.`, { title: `Apply the threshold to ${pending.length} student(s)?`, confirmLabel: 'Apply threshold' })) return;

  showLoading();
  try {
    for (const promo of pending) {
      const row = rows.find(r => r.studentId === promo.student_id);
      const card = row ? (cards || []).find(c => c.id === row.thirdTermCardId) : null;
      const decision = promo.recommended_status === 'promote' ? 'promoted' : 'repeated';
      await applyPromotionDecision(promo, card ? card.id : null, arm.classId, decision);
    }
    showToast(`Done — ${willPromote} promoted, ${willRepeat} repeating.`, 'success');
    loadPromotionsScreen();
  } catch (err) {
    showToast(err.message || 'Could not apply promotions.', 'error');
  } finally {
    hideLoading();
  }
}

/* ----------------------------------------------------------------------------
   21b. SESSION ROLLOVER — "move to a new academic session"
   Trigger points: right after any Third Term report card is published, and
   once on every admin login. Both call checkSessionRolloverPrompt(), which
   only actually shows the modal if (a) EVERY enrolled Third Term student
   across every class has a published report card — i.e. the whole session
   is done, not just one class — and (b) no successor session exists yet
   (sessions.previous_session_id pointing back to this one) — so saying
   "Not yet" is free: nothing is written, and the same check just fires
   again next time.
   ---------------------------------------------------------------------------- */
async function checkSessionRolloverPrompt() {
  if (!appState.user || appState.user.role !== 'admin' || !appState.activeSessionId) return;

  const { data: thirdTerm } = await supabaseClient
    .from('terms').select('id').eq('session_id', appState.activeSessionId).eq('name', 'Third Term').maybeSingle();
  if (!thirdTerm) return;

  const { data: thirdTermEnrollments } = await supabaseClient
    .from('enrollments').select('id').eq('term_id', thirdTerm.id).neq('status', 'withdrawn');
  if (!thirdTermEnrollments || thirdTermEnrollments.length === 0) return;

  // Every enrolled student, across every class, needs a published report
  // card before we prompt — one class finishing early isn't enough.
  const { data: cards } = await supabaseClient
    .from('report_cards').select('enrollment_id, published_at').eq('is_annual', false)
    .in('enrollment_id', thirdTermEnrollments.map(e => e.id));

  const publishedByEnrollment = {};
  (cards || []).forEach(c => { if (c.published_at) publishedByEnrollment[c.enrollment_id] = true; });
  const allPublished = thirdTermEnrollments.every(e => publishedByEnrollment[e.id]);
  if (!allPublished) return;

  const { data: successor } = await supabaseClient
    .from('sessions').select('id').eq('previous_session_id', appState.activeSessionId).maybeSingle();
  if (successor) return;

  const { data: session } = await supabaseClient.from('sessions').select('name').eq('id', appState.activeSessionId).single();
  document.getElementById('session-rollover-current-name').textContent = session ? session.name : 'this session';
  document.getElementById('session-rollover-prompt').classList.remove('hidden');
}

function closeSessionWizardModal() {
  document.getElementById('session-wizard-modal').classList.add('hidden');
  document.getElementById('session-wizard-form').reset();
  document.getElementById('session-wizard-error').classList.add('hidden');
}

// Creates the new session + its 3 terms, carries every student from the
// current session's Third Term into the new First Term (using their
// Promotions decision where one exists), then makes the new session/term
// active app-wide.
async function createNextSessionAndRollover({ sessionName, termDates }) {
  const { data: newSession, error: sessionErr } = await supabaseClient
    .from('sessions')
    .insert({ name: sessionName, is_active: false, previous_session_id: appState.activeSessionId })
    .select().single();
  if (sessionErr) throw sessionErr;

  const termRows = TERM_ORDER.map(name => ({
    session_id: newSession.id,
    name,
    start_date: termDates[name].start,
    end_date: termDates[name].end,
    is_current: false,
    is_result_entry_open: false,
  }));
  const { data: newTerms, error: termsErr } = await supabaseClient.from('terms').insert(termRows).select();
  if (termsErr) throw termsErr;
  const newFirstTerm = newTerms.find(t => t.name === 'First Term');

  // Every student enrolled in the outgoing Third Term, so no one gets
  // silently dropped even if Promotions was never touched for them.
  const { data: oldThirdTerm } = await supabaseClient
    .from('terms').select('id').eq('session_id', appState.activeSessionId).eq('name', 'Third Term').single();
  const { data: thirdTermEnrollments } = await supabaseClient
    .from('enrollments').select('id, student_id, class_id, arm_id').eq('term_id', oldThirdTerm.id).neq('status', 'withdrawn');

  const { data: promotions } = await supabaseClient
    .from('promotions').select('student_id, final_status, to_class_id, from_class_id').eq('session_id', appState.activeSessionId);
  const promoByStudent = {};
  (promotions || []).forEach(p => { promoByStudent[p.student_id] = p; });

  const { data: studentsRows } = await supabaseClient
    .from('students').select('id, enrollment_status').in('id', (thirdTermEnrollments || []).map(e => e.student_id));
  const enrollmentStatusByStudent = {};
  (studentsRows || []).forEach(s => { enrollmentStatusByStudent[s.id] = s.enrollment_status; });

  await refreshClassesWithArmsCache();

  let carried = 0, undecided = 0, skippedGraduated = 0, skippedNoArm = 0, skippedWithdrawn = 0;
  const newEnrollmentRows = [];

  for (const e of (thirdTermEnrollments || [])) {
    if (enrollmentStatusByStudent[e.student_id] === 'graduated') { skippedGraduated++; continue; }
    if (enrollmentStatusByStudent[e.student_id] === 'withdrawn') { skippedWithdrawn++; continue; }

    const promo = promoByStudent[e.student_id];
    let targetClassId = e.class_id;
    if (promo) {
      targetClassId = promo.to_class_id || promo.from_class_id || e.class_id;
    } else {
      undecided++;
    }

    const targetClass = classesWithArmsCache.find(c => c.id === targetClassId);
    if (!targetClass || targetClass.arms.length === 0) { skippedNoArm++; continue; }

    // Every class has exactly one hidden arm behind the scenes, so there's
    // nothing to match — just use it.
    const chosenArm = targetClass.arms[0];

    newEnrollmentRows.push({
      student_id: e.student_id,
      session_id: newSession.id,
      term_id: newFirstTerm.id,
      class_id: targetClassId,
      arm_id: chosenArm.id,
      status: 'active',
    });
    carried++;
  }

  if (newEnrollmentRows.length > 0) {
    const { error: enrollErr } = await supabaseClient.from('enrollments').insert(newEnrollmentRows);
    if (enrollErr) throw enrollErr;
  }

  // Flip the whole app over to the new session/term. Cleared globally (not
  // just within the old session) so there's never more than one is_active
  // session or is_current term at once, matching how loadActiveSessionAndTerm()
  // reads them (no session filter).
  await supabaseClient.from('sessions').update({ is_active: false }).eq('is_active', true);
  await supabaseClient.from('sessions').update({ is_active: true }).eq('id', newSession.id);
  await supabaseClient.from('terms').update({ is_current: false }).eq('is_current', true);
  await supabaseClient.from('terms').update({ is_current: true }).eq('id', newFirstTerm.id);

  setState({ activeSessionId: newSession.id, activeTermId: newFirstTerm.id });

  return { carried, undecided, skippedGraduated, skippedNoArm, skippedWithdrawn };
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('session-rollover-not-yet-btn').addEventListener('click', () => {
    document.getElementById('session-rollover-prompt').classList.add('hidden');
  });

  document.getElementById('session-rollover-yes-btn').addEventListener('click', () => {
    document.getElementById('session-rollover-prompt').classList.add('hidden');
    document.getElementById('session-wizard-modal').classList.remove('hidden');
  });

  document.getElementById('session-wizard-cancel-btn').addEventListener('click', closeSessionWizardModal);

  document.getElementById('session-wizard-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('session-wizard-error');
    errorEl.classList.add('hidden');

    const sessionName = document.getElementById('sw-session-name').value.trim();
    const termDates = {};
    let datesValid = true;
    document.querySelectorAll('#session-wizard-form .wizard-term-row').forEach(row => {
      const start = row.querySelector('[data-field="start"]').value;
      const end = row.querySelector('[data-field="end"]').value;
      if (!start || !end || end < start) datesValid = false;
      termDates[row.dataset.term] = { start, end };
    });
    if (!sessionName || !datesValid) {
      errorEl.textContent = 'Enter a session name and make sure every term has a start date on or before its end date.';
      errorEl.classList.remove('hidden');
      return;
    }

    showLoading();
    try {
      const result = await createNextSessionAndRollover({ sessionName, termDates });
      closeSessionWizardModal();
      showToast(
        `"${sessionName}" is now the active session. ${result.carried} student(s) carried into First Term` +
        (result.undecided > 0 ? ` (${result.undecided} without a promotion decision — carried at their current class)` : '') +
        (result.skippedGraduated > 0 ? `. ${result.skippedGraduated} graduated student(s) skipped` : '') +
        (result.skippedWithdrawn > 0 ? `. ${result.skippedWithdrawn} withdrawn student(s) skipped` : '') +
        (result.skippedNoArm > 0 ? `. ${result.skippedNoArm} skipped — target class isn't set up yet` : '') + '.',
        'success'
      );
      renderTopbarContext();
      navigateTo(appState.currentView);
    } catch (err) {
      errorEl.textContent = err.message || 'Could not create the new session.';
      errorEl.classList.remove('hidden');
    } finally {
      hideLoading();
    }
  });
});

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
      .from('enrollments').select('class_id, classes(name)').eq('term_id', appState.activeTermId).neq('status', 'withdrawn');
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
  `;
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
    if (!await showConfirmDialog('This cannot be undone.', { title: 'Delete this announcement?', confirmLabel: 'Delete', danger: true })) return;
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
    const { data, error } = await supabaseClient
      .from('announcements').update({ is_published: published }).eq('id', id).select().single();
    if (error) throw error;
    if (published && data) notifyAnnouncementAudience(data);
    loadAnnouncementsScreen();
  } catch (err) {
    showToast(err.message || 'Could not update.', 'error');
  } finally {
    hideLoading();
  }
}

// Emails the announcement's chosen audience the moment it's published.
// audience is 'all' | 'teachers' | 'parents' (set when the announcement was
// created). Admin already has full read access to staff/parents (same
// tables the Staff & Teachers / Parents screens use), so no extra RPC is
// needed here — unlike the teacher-triggered notifications above.
async function notifyAnnouncementAudience(announcement) {
  try {
    const recipients = [];

    if (announcement.audience === 'all' || announcement.audience === 'teachers') {
      const { data: staffRows } = await supabaseClient.from('staff').select('users(email, role)');
      (staffRows || []).forEach(s => {
        if (s.users && s.users.email && s.users.role === 'teacher') recipients.push(s.users.email);
      });
    }
    if (announcement.audience === 'all' || announcement.audience === 'parents') {
      const { data: parentRows } = await supabaseClient.from('parents').select('users(email)');
      (parentRows || []).forEach(p => {
        if (p.users && p.users.email) recipients.push(p.users.email);
      });
    }

    if (recipients.length === 0) return;
    sendAppsScriptBulkEmail({
      recipients,
      subject: `New announcement: ${announcement.title}`,
      body: `${announcement.body}\n\n— ${appState.schoolSettings?.school_name || 'The school'}`,
    });
  } catch (err) {
    console.warn('Could not notify announcement audience:', err);
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

// Carries students forward automatically when switching to a term within the
// SAME session that has no enrollments yet — e.g. First Term -> Second Term.
// It never runs across a session boundary (that's what Promotions is for),
// and it never overwrites an existing enrollment: if the target term already
// has any rows, it's left alone so this is always safe to call.
async function rolloverEnrollmentsToTerm(targetTermId, sessionId, sessionTerms) {
  const { data: existing } = await supabaseClient
    .from('enrollments').select('id').eq('term_id', targetTermId).limit(1);
  if (existing && existing.length > 0) return 0; // already has enrollments — don't touch it

  // Nearest earlier term in this same session (by start_date) that already
  // has enrollments — that's what we roll forward from. Handles skipping
  // straight to Third Term, or any term whose immediate predecessor was
  // itself never populated.
  const targetTerm = sessionTerms.find(t => t.id === targetTermId);
  if (!targetTerm) return 0;
  const earlierTerms = sessionTerms
    .filter(t => t.id !== targetTermId && (t.start_date || '') <= (targetTerm.start_date || '9999-99-99'))
    .sort((a, b) => (b.start_date || '').localeCompare(a.start_date || ''));

  let sourceEnrollments = [];
  for (const t of earlierTerms) {
    const { data } = await supabaseClient
      .from('enrollments').select('student_id, class_id, arm_id').eq('term_id', t.id);
    if (data && data.length > 0) { sourceEnrollments = data; break; }
  }
  if (sourceEnrollments.length === 0) return 0;

  const newRows = sourceEnrollments.map(e => ({
    student_id: e.student_id,
    session_id: sessionId,
    term_id: targetTermId,
    class_id: e.class_id,
    arm_id: e.arm_id,
    status: 'active',
  }));

  const { error } = await supabaseClient.from('enrollments').insert(newRows);
  if (error) throw error;
  return newRows.length;
}

/* ----------------------------------------------------------------------------
   27. SCHOOL SETTINGS + BACKUP EXPORT (Phase 8)
   ---------------------------------------------------------------------------- */
async function loadSettingsScreen() {
  const container = document.getElementById('settings-content');
  const s = appState.schoolSettings || {};

  let termsCardHTML = `<div class="card card-notice"><p>No academic session set up yet — complete the Setup Wizard first.</p></div>`;
  let terms = [];
  if (appState.activeSessionId) {
    const { data } = await supabaseClient
      .from('terms')
      .select('*')
      .eq('session_id', appState.activeSessionId)
      .order('start_date', { ascending: true, nullsFirst: true });
    terms = data || [];

    termsCardHTML = `
      <div class="card">
        <div class="card-title-row">
          <h2 class="card-title">Academic term</h2>
          <span class="badge badge-navy">${escapeHtml(terms.find(t => t.is_current)?.name || 'No current term')}</span>
        </div>
        <p class="view-subheading">Only one term can be active at a time — it drives every screen in the app (results entry, report cards, dashboards). Switching is safe: past terms and their results, approvals, and report cards stay exactly as they are.</p>
        <table class="data-table">
          <thead><tr><th>Term</th><th>Dates</th><th>Result entry</th><th>Status</th><th></th></tr></thead>
          <tbody>
            ${terms.map(t => `
              <tr>
                <td>${escapeHtml(t.name)}</td>
                <td>${t.start_date ? new Date(t.start_date).toLocaleDateString() : '—'} – ${t.end_date ? new Date(t.end_date).toLocaleDateString() : '—'}</td>
                <td><span class="badge ${t.is_result_entry_open ? 'badge-success' : 'badge-error'}">${t.is_result_entry_open ? 'Open' : 'Closed'}</span>
                  <button type="button" class="icon-btn" data-toggle-entry="${t.id}" data-open="${t.is_result_entry_open}">${t.is_result_entry_open ? 'Close' : 'Open'}</button>
                </td>
                <td>${t.is_current ? `<span class="badge badge-gold">Current</span>` : '—'}</td>
                <td>${t.is_current ? '' : `<button type="button" class="icon-btn" data-make-active="${t.id}">Make active</button>`}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  container.innerHTML = `
    ${termsCardHTML}

    <div id="previous-sessions-wrap"></div>

    <div class="card">
      <h2 class="card-title">Identity &amp; branding</h2>
      <p class="view-subheading">Applies app-wide immediately — the login screen, sidebar, and every generated report card.</p>

      <p class="settings-subhead">Basic details</p>
      <div class="form-grid">
        <div><label class="field-label">School name</label><input class="field-input" id="set-school-name" value="${escapeHtml(s.school_name || '')}"></div>
        <div><label class="field-label">Motto</label><input class="field-input" id="set-motto" value="${escapeHtml(s.motto || '')}"></div>
        <div><label class="field-label">Phone</label><input class="field-input" id="set-phone" value="${escapeHtml(s.phone || '')}"></div>
        <div><label class="field-label">Email</label><input class="field-input" id="set-email" value="${escapeHtml(s.email || '')}"></div>
        <div><label class="field-label">Address</label><input class="field-input" id="set-address" value="${escapeHtml(s.address || '')}"></div>
        <div><label class="field-label">Principal's name</label><input class="field-input" id="set-principal-name" value="${escapeHtml(s.principal_name || '')}"></div>
      </div>

      <p class="settings-subhead">Branding assets</p>
      <div class="form-grid">
        <div>
          <label class="field-label">Theme color</label>
          <div class="theme-color-row">
            <input class="field-input" type="color" id="set-theme-color" value="${s.theme_color || '#1B2A4A'}">
            <span class="theme-color-hex" id="set-theme-color-hex">${escapeHtml(s.theme_color || '#1B2A4A')}</span>
          </div>
        </div>
        <div></div>
        <div><label class="field-label">New logo</label><input class="field-input" type="file" id="set-logo-file" accept="image/*"></div>
        <div><label class="field-label">New principal signature</label><input class="field-input" type="file" id="set-signature-file" accept="image/*"></div>
        <div><label class="field-label">New report watermark</label><input class="field-input" type="file" id="set-watermark-file" accept="image/*"></div>
      </div>

      <div class="form-actions"><button type="button" class="btn btn-primary" id="save-settings-btn">Save settings</button></div>
    </div>

    <div class="card">
      <h2 class="card-title">Email notifications</h2>
      <p class="view-subheading">Sent automatically by a Google Apps Script Web App (see Code.gs) — it's the only thing that sends email for this system, including password resets. It emails: staff/parents an activation invite when added; parents a welcome note when they self-register; admins when results are submitted for approval and when a teacher confirms a report card is ready; teachers and parents when a report card is published (with a direct link); the chosen audience when an announcement is published; and 6-digit codes for "Forgot password?". Nothing to configure here — it's wired in already.</p>
      <div class="form-actions">
        <button type="button" class="btn btn-ghost-dark" id="test-webhook-btn">Send test email to school address</button>
      </div>
    </div>

    <div class="card">
      <h2 class="card-title">Grading system</h2>
      <p class="view-subheading">Define the score bands used to assign a grade and remark to every subject total (e.g. 70–100 = A). Overlapping or gapped ranges are the most common cause of wrong grades on report cards.</p>
      <div id="grading-rules-rows" class="wizard-grading-rows"></div>
      <div class="form-actions">
        <button type="button" class="btn btn-ghost-dark" id="add-grading-row-btn">+ Add band</button>
        <button type="button" class="btn btn-primary" id="save-grading-btn">Save grading system</button>
      </div>
      <p class="field-error hidden" id="grading-form-error" role="alert"></p>
      <p class="view-subheading" id="grading-recalc-note" style="margin-top:10px;"></p>
    </div>

    <div class="card">
      <h2 class="card-title">Backup / export</h2>
      <p class="view-subheading">Downloads a JSON snapshot of core data. Destructive actions elsewhere in the app already require confirmation, so this is for off-site backup, not undo.</p>
      <div class="form-actions" style="flex-wrap:wrap;">
        <button type="button" class="btn btn-ghost-dark" data-export="students">Export students</button>
        <button type="button" class="btn btn-ghost-dark" data-export="results">Export results</button>
        <button type="button" class="btn btn-ghost-dark" data-export="report_cards">Export report cards</button>
      </div>
    </div>
  `;

  const themeColorInput = document.getElementById('set-theme-color');
  const themeColorHex = document.getElementById('set-theme-color-hex');
  if (themeColorInput) {
    themeColorInput.addEventListener('input', () => {
      themeColorHex.textContent = themeColorInput.value.toUpperCase();
    });
  }


  await loadAndRenderGradingRules();
  wireGradingRulesForm();

  container.querySelectorAll('[data-make-active]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const term = terms.find(t => t.id === btn.dataset.makeActive);
      if (!await showConfirmDialog(`Everyone will immediately see it as the current term app-wide. Students will automatically carry over into it from whichever term they were last enrolled in this session — nothing changes for them unless you transfer or promote them yourself. Result entry for it will need to be opened separately below if needed.`, { title: `Make "${term ? term.name : 'this term'}" the active term?`, confirmLabel: 'Make active' })) return;
      showLoading();
      try {
        const { error: clearErr } = await supabaseClient
          .from('terms').update({ is_current: false }).eq('session_id', appState.activeSessionId);
        if (clearErr) throw clearErr;
        const { error: setErr } = await supabaseClient
          .from('terms').update({ is_current: true }).eq('id', btn.dataset.makeActive);
        if (setErr) throw setErr;

        const carriedOver = await rolloverEnrollmentsToTerm(btn.dataset.makeActive, appState.activeSessionId, terms);

        setState({ activeTermId: btn.dataset.makeActive });
        renderTopbarContext();
        showToast(
          carriedOver > 0
            ? `${term ? term.name : 'Term'} is now active — ${carriedOver} student(s) carried over automatically, same class as before.`
            : `${term ? term.name : 'Term'} is now the active term.`,
          'success'
        );
        loadSettingsScreen();
      } catch (err) {
        showToast(err.message || 'Could not switch the active term.', 'error');
      } finally {
        hideLoading();
      }
    });
  });

  container.querySelectorAll('[data-toggle-entry]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const isOpen = btn.dataset.open === 'true';
      showLoading();
      try {
        const { error } = await supabaseClient
          .from('terms').update({ is_result_entry_open: !isOpen }).eq('id', btn.dataset.toggleEntry);
        if (error) throw error;
        showToast(`Result entry ${!isOpen ? 'opened' : 'closed'}.`, 'success');
        loadSettingsScreen();
      } catch (err) {
        showToast(err.message || 'Could not update result entry.', 'error');
      } finally {
        hideLoading();
      }
    });
  });

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
    const url = APPS_SCRIPT_WEBHOOK_URL;
    const schoolEmail = document.getElementById('set-email').value.trim();
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
      showToast(err.message || 'Could not reach the Apps Script webhook. Double-check it\'s deployed with "Anyone" access.', 'error');
    } finally {
      hideLoading();
    }
  });

  renderPreviousSessionsCard();
}

/* ----------------------------------------------------------------------------
   27a. GRADING SYSTEM MANAGEMENT (Admin) — School Settings
   Lets the admin view/add/remove/edit score bands after initial setup
   (the wizard only ever ran once), and optionally recalculate the grade +
   remark on every already-saved result to match corrected bands — this is
   the fix for report cards showing the wrong letter grade for a score.
   ---------------------------------------------------------------------------- */
function addGradingRuleRow(prefill) {
  const container = document.getElementById('grading-rules-rows');
  const row = document.createElement('div');
  row.className = 'wizard-grading-row';
  const p = prefill || { min_score: '', max_score: '', grade: '', remark: '' };
  row.innerHTML = `
    <input class="field-input" data-field="min" type="number" placeholder="Min" value="${p.min_score}">
    <input class="field-input" data-field="max" type="number" placeholder="Max" value="${p.max_score}">
    <input class="field-input" data-field="grade" placeholder="Grade" value="${escapeHtml(p.grade || '')}">
    <input class="field-input" data-field="remark" placeholder="Remark" value="${escapeHtml(p.remark || '')}">
    <button type="button" class="wizard-remove-row-btn">Remove</button>
  `;
  row.querySelector('.wizard-remove-row-btn').addEventListener('click', () => row.remove());
  container.appendChild(row);
}

async function loadAndRenderGradingRules() {
  const container = document.getElementById('grading-rules-rows');
  if (!container) return;
  container.innerHTML = '';
  const { data, error } = await supabaseClient
    .from('grading_rules').select('*').is('session_id', null).order('min_score', { ascending: false });
  if (error) { showToast(error.message, 'error'); return; }
  if (!data || data.length === 0) {
    addGradingRuleRow();
  } else {
    data.forEach(rule => addGradingRuleRow(rule));
  }
}

function wireGradingRulesForm() {
  const addBtn = document.getElementById('add-grading-row-btn');
  const saveBtn = document.getElementById('save-grading-btn');
  if (!addBtn || !saveBtn) return;

  addBtn.onclick = () => addGradingRuleRow();

  saveBtn.onclick = async () => {
    const errorEl = document.getElementById('grading-form-error');
    const note = document.getElementById('grading-recalc-note');
    errorEl.classList.add('hidden');
    note.textContent = '';

    const rows = Array.from(document.querySelectorAll('#grading-rules-rows .wizard-grading-row')).map(row => ({
      min_score: Number(row.querySelector('[data-field="min"]').value),
      max_score: Number(row.querySelector('[data-field="max"]').value),
      grade: row.querySelector('[data-field="grade"]').value.trim(),
      remark: row.querySelector('[data-field="remark"]').value.trim(),
    }));

    if (rows.length === 0 || rows.some(r => !r.grade || !r.remark || Number.isNaN(r.min_score) || Number.isNaN(r.max_score))) {
      errorEl.textContent = 'Every grading band needs a min, max, grade, and remark.';
      errorEl.classList.remove('hidden');
      return;
    }
    if (rows.some(r => r.min_score > r.max_score)) {
      errorEl.textContent = 'Each band\'s min score must not be greater than its max score.';
      errorEl.classList.remove('hidden');
      return;
    }
    // Check for overlapping bands, e.g. 60-69 and 65-75 sharing 65-69.
    const sorted = [...rows].sort((a, b) => a.min_score - b.min_score);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].min_score <= sorted[i - 1].max_score) {
        errorEl.textContent = `Bands overlap: ${sorted[i - 1].min_score}–${sorted[i - 1].max_score} and ${sorted[i].min_score}–${sorted[i].max_score} both include ${sorted[i].min_score}. Fix the ranges so each score matches exactly one band.`;
        errorEl.classList.remove('hidden');
        return;
      }
    }

    showLoading();
    try {
      const { error: delErr } = await supabaseClient.from('grading_rules').delete().is('session_id', null);
      if (delErr) throw delErr;
      const { error: insErr } = await supabaseClient.from('grading_rules').insert(rows);
      if (insErr) throw insErr;

      showToast('Grading system saved.', 'success');

      // Recalculate grade + remark on every already-saved result to match the new bands.
      const { data: results, error: resultsErr } = await supabaseClient
        .from('results').select('id, total_score').not('total_score', 'is', null);
      if (resultsErr) throw resultsErr;

      // Group results by their new (grade, remark) pair so each distinct pair only
      // needs ONE update call (touching many rows via .in()), instead of one call
      // per row. Plain .update() is used — not .upsert() — because Postgres checks
      // NOT NULL constraints on the upsert's underlying INSERT payload even when the
      // row already exists and the statement really just falls through to an UPDATE.
      const findBand = (score) => rows.find(r => score >= r.min_score && score <= r.max_score);
      const groups = new Map(); // "grade|remark" -> [result ids]
      (results || []).forEach(r => {
        const band = findBand(r.total_score);
        if (!band) return;
        const key = `${band.grade}|||${band.remark}`;
        if (!groups.has(key)) groups.set(key, { grade: band.grade, remark: band.remark, ids: [] });
        groups.get(key).ids.push(r.id);
      });

      let updatedCount = 0;
      const CHUNK = 300;
      for (const { grade, remark, ids } of groups.values()) {
        for (let i = 0; i < ids.length; i += CHUNK) {
          const idChunk = ids.slice(i, i + CHUNK);
          const { error: upErr } = await supabaseClient
            .from('results').update({ grade, remark }).in('id', idChunk);
          if (upErr) throw upErr;
          updatedCount += idChunk.length;
        }
      }

      note.textContent = updatedCount > 0
        ? `Recalculated grade and remark on ${updatedCount} existing result(s) to match the new bands.`
        : 'No existing results needed recalculating.';

      loadAndRenderGradingRules();
    } catch (err) {
      errorEl.textContent = err.message || 'Could not save the grading system.';
      errorEl.classList.remove('hidden');
    } finally {
      hideLoading();
    }
  };
}

/* ----------------------------------------------------------------------------
   27b. PREVIOUS SESSIONS VIEWER (Admin) — School Settings
   Read-only browsing of any session that isn't the currently active one:
   pick a session, pick a term, pick a class, then preview any report
   card that was ever generated for a student in that arm/term.
   ---------------------------------------------------------------------------- */
let prevSessionState = { sessionId: null, termId: null };

async function renderPreviousSessionsCard() {
  const wrap = document.getElementById('previous-sessions-wrap');
  if (!wrap) return;

  let query = supabaseClient.from('sessions').select('id, name').order('name', { ascending: false });
  if (appState.activeSessionId) query = query.neq('id', appState.activeSessionId);
  const { data: pastSessions } = await query;

  if (!pastSessions || pastSessions.length === 0) {
    wrap.innerHTML = `<div class="card card-notice"><p>No previous sessions yet — they'll appear here once you move to a new academic session.</p></div>`;
    return;
  }

  if (!prevSessionState.sessionId || !pastSessions.some(s => s.id === prevSessionState.sessionId)) {
    prevSessionState = { sessionId: pastSessions[0].id, termId: null };
  }

  wrap.innerHTML = `
    <div class="card">
      <h2 class="card-title">Previous sessions</h2>
      <p class="view-subheading">Browse terms and report cards from a session that's no longer active.</p>
      <label class="field-label" for="prev-session-select">Session</label>
      <select class="field-input" id="prev-session-select">
        ${pastSessions.map(s => `<option value="${s.id}" ${s.id === prevSessionState.sessionId ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('')}
      </select>
      <div id="prev-session-terms-wrap" style="margin-top:14px;"></div>
    </div>
  `;

  document.getElementById('prev-session-select').addEventListener('change', (e) => {
    prevSessionState = { sessionId: e.target.value, termId: null };
    renderPrevSessionTerms();
  });

  renderPrevSessionTerms();
}

async function renderPrevSessionTerms() {
  const wrap = document.getElementById('prev-session-terms-wrap');
  if (!wrap) return;
  const { data: terms } = await supabaseClient
    .from('terms').select('id, name, start_date, end_date')
    .eq('session_id', prevSessionState.sessionId)
    .order('start_date', { ascending: true, nullsFirst: true });

  wrap.innerHTML = `
    <table class="data-table">
      <thead><tr><th>Term</th><th>Dates</th><th></th></tr></thead>
      <tbody>
        ${(terms || []).map(t => `
          <tr>
            <td>${escapeHtml(t.name)}</td>
            <td>${t.start_date ? new Date(t.start_date).toLocaleDateString() : '—'} – ${t.end_date ? new Date(t.end_date).toLocaleDateString() : '—'}</td>
            <td><button type="button" class="icon-btn" data-view-prev-term="${t.id}">View classes &amp; report cards</button></td>
          </tr>`).join('') || '<tr class="empty-row"><td colspan="3">No terms recorded.</td></tr>'}
      </tbody>
    </table>
    <div id="prev-session-arms-wrap" style="margin-top:14px;"></div>
  `;

  wrap.querySelectorAll('[data-view-prev-term]').forEach(btn => {
    btn.addEventListener('click', () => { prevSessionState.termId = btn.dataset.viewPrevTerm; renderPrevSessionArms(); });
  });

  if (prevSessionState.termId && (terms || []).some(t => t.id === prevSessionState.termId)) {
    renderPrevSessionArms();
  }
}

async function renderPrevSessionArms() {
  const wrap = document.getElementById('prev-session-arms-wrap');
  if (!wrap) return;

  const { data: enrollments } = await supabaseClient
    .from('enrollments').select('id, arm_id, classes(name), class_arms(name)').eq('term_id', prevSessionState.termId);

  const armGroups = {};
  (enrollments || []).forEach(e => {
    if (!armGroups[e.arm_id]) {
      armGroups[e.arm_id] = { armId: e.arm_id, className: e.classes?.name || '—', armName: e.class_arms?.name || '', enrollmentIds: [] };
    }
    armGroups[e.arm_id].enrollmentIds.push(e.id);
  });
  const groups = Object.values(armGroups);

  if (groups.length === 0) {
    wrap.innerHTML = `<p class="view-subheading">No students were enrolled in this term.</p>`;
    return;
  }

  wrap.innerHTML = `
    <label class="field-label" for="prev-arm-select">Class</label>
    <select class="field-input" id="prev-arm-select" style="max-width:280px;">
      ${groups.map(g => `<option value="${g.armId}">${escapeHtml(g.className)}</option>`).join('')}
    </select>
    <div id="prev-arm-students-wrap" style="margin-top:12px;"></div>
  `;

  const showArm = async (armId) => {
    const group = groups.find(g => g.armId === armId);
    const { data: enr } = await supabaseClient.from('enrollments').select('id, students(full_name)').in('id', group.enrollmentIds);
    const { data: cards } = await supabaseClient.from('report_cards').select('*').eq('is_annual', false).in('enrollment_id', group.enrollmentIds);
    const cardByEnrollment = {};
    (cards || []).forEach(c => { cardByEnrollment[c.enrollment_id] = c; });

    const studentsWrap = document.getElementById('prev-arm-students-wrap');
    studentsWrap.innerHTML = `
      <table class="data-table">
        <thead><tr><th>Student</th><th>Status</th><th></th></tr></thead>
        <tbody>
          ${(enr || []).map(e => {
            const card = cardByEnrollment[e.id];
            const label = !card ? 'No report card' : card.published_at ? 'Published' : 'Generated, not published';
            const badge = !card ? 'badge-error' : card.published_at ? 'badge-success' : 'badge-navy';
            return `
              <tr>
                <td>${escapeHtml(e.students.full_name)}</td>
                <td><span class="badge ${badge}">${label}</span></td>
                <td>${card ? `<button type="button" class="icon-btn" data-prev-preview="${card.id}">Preview</button>` : ''}</td>
              </tr>`;
          }).join('')}
        </tbody>
      </table>
    `;
    studentsWrap.querySelectorAll('[data-prev-preview]').forEach(btn => {
      btn.addEventListener('click', () => openReportCardPreview(btn.dataset.prevPreview));
    });
  };

  document.getElementById('prev-arm-select').addEventListener('change', (e) => showArm(e.target.value));
  showArm(groups[0].armId);
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
  document.getElementById('show-activate-btn').addEventListener('click', () => showActivateForm(true));
  document.getElementById('back-to-login-btn').addEventListener('click', () => showActivateForm(false));
  document.getElementById('activate-form').addEventListener('submit', handleActivateSubmit);
  document.getElementById('show-register-btn').addEventListener('click', () => showRegisterForm(true));
  document.getElementById('back-to-login-from-register-btn').addEventListener('click', () => showRegisterForm(false));
  document.getElementById('register-form').addEventListener('submit', handleRegisterSubmit);
  document.getElementById('register-child-count').addEventListener('change', renderRegisterChildRows);
  document.getElementById('register-add-child-btn').addEventListener('click', () => {
    addRegisterChildRow();
    document.getElementById('register-child-count').value =
      document.getElementById('register-children-rows').querySelectorAll('.wizard-repeat-row').length;
  });
  document.getElementById('show-contact-btn').addEventListener('click', () => showContactForm(true));
  document.getElementById('back-to-login-from-contact-btn').addEventListener('click', () => showContactForm(false));
  document.getElementById('contact-form').addEventListener('submit', handleContactSubmit);
  document.getElementById('logout-btn').addEventListener('click', handleLogout);
  document.getElementById('sidebar-toggle-btn').addEventListener('click', toggleSidebar);
  document.getElementById('sidebar-backdrop').addEventListener('click', closeMobileSidebar);
  initConfirmDialog();

  // A report-card-published email links straight to ?rc=<id>. Stash it
  // (works whether or not the person is signed in yet) and consume it once
  // the app shell is actually up, in enterAppShell() below.
  const rcParam = new URLSearchParams(window.location.search).get('rc');
  if (rcParam) sessionStorage.setItem('pendingReportCardId', rcParam);

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
