/* ============================================================================
   Strong Pillar Int'l Nursery and Primary School — PARENT PORTAL
   app.js — everything that is specific to parents.

   Loaded AFTER core.js, which provides the Supabase client, appState,
   sign-in, the password-reset flow, the router, and the report-card viewer.

   This build contains no admin or teacher code of any kind: no student
   records, no staff management, no score entry, no approvals, no settings.
   A parent's browser never downloads those screens at all.
   ============================================================================ */

/* ----------------------------------------------------------------------------
   NAV — parents only ever see three screens.
   ---------------------------------------------------------------------------- */
const NAV_BY_ROLE = {
  parent: [
    { key: 'dashboard', label: 'Dashboard', icon: '\u25C6' },
    { key: 'students', label: 'Students', icon: '\u25C6' },
    { key: 'reportcards', label: 'Report Cards', icon: '\u25C6' },
    { key: 'announcements', label: 'Announcements', icon: '\u25C6' },
    { key: 'profile', label: 'Profile', icon: '\u25C6' },
  ],
};

// Where to send someone who signs in here but isn't a parent.
const STAFF_PORTAL_URL = '../admin/';

/* ----------------------------------------------------------------------------
   BRANDING — applied to this portal's own login markup.
   ---------------------------------------------------------------------------- */
function applySchoolBranding(settings) {
  if (settings.school_name) {
    document.querySelectorAll('[data-school-name]').forEach(el => { el.textContent = settings.school_name; });
    document.getElementById('sidebar-school-name').textContent = settings.school_name;
    document.title = `${settings.school_name} \u2014 Parent Portal`;
  }
  if (settings.motto) {
    document.querySelectorAll('[data-school-motto]').forEach(el => { el.textContent = settings.motto; });
  }
  if (settings.logo_url) {
    document.querySelectorAll('[data-school-logo]').forEach(img => {
      img.src = settings.logo_url;
      img.classList.remove('hidden');
      const fallback = img.parentElement.querySelector('.crest-fallback');
      if (fallback) fallback.classList.add('hidden');
    });
  }
  if (settings.theme_color) {
    document.documentElement.style.setProperty('--color-navy', settings.theme_color);
  }
}

/* ----------------------------------------------------------------------------
   SIGN-IN -> PARENT SHELL
   Anyone whose role isn't `parent` is bounced to the staff portal. The real
   protection is Supabase RLS; this is the friendly front door.
   ---------------------------------------------------------------------------- */
async function loadUserProfileAndEnterApp(authUser) {
  let { data: profile } = await supabaseClient
    .from('users')
    .select('id, role, full_name, email, phone, is_active')
    .eq('id', authUser.id)
    .maybeSingle();

  if (!profile) {
    // The database trigger creates the profile; wait briefly for it to show
    // up rather than creating one from here (see sql/02).
    profile = await waitForProfileRow(authUser);
    if (!profile) {
      showToast('Your account has no profile record yet. Wait a moment and sign in again, or contact the school office.', 'error');
      await supabaseClient.auth.signOut();
      return;
    }
  }

  if (!profile) {
    showToast('Could not load your profile. Please try signing in again.', 'error');
    await supabaseClient.auth.signOut();
    return;
  }

  if (!profile.is_active) {
    showToast('This account has been deactivated. Contact the school office.', 'error');
    await supabaseClient.auth.signOut();
    return;
  }

  if (profile.role !== 'parent') {
    await rejectWrongPortal(
      'This is the parent portal. Staff and administrators sign in on the staff portal \u2014 taking you there now.',
      STAFF_PORTAL_URL
    );
    return;
  }

  setState({ authUser, user: profile });
  await loadSchoolSettings();
  await loadActiveSessionAndTerm();

  if (!appState.schoolSettings || !appState.schoolSettings.setup_completed) {
    showToast('The school has not finished setting up the system yet. Please try again later.', 'error');
    await supabaseClient.auth.signOut();
    setState({ user: null, authUser: null });
    return;
  }

  enterAppShell();
}

/* ----------------------------------------------------------------------------
   VIEW SWITCHING — no setup wizard exists in this build.
   ---------------------------------------------------------------------------- */
function showView(name) {
  document.getElementById('view-login').classList.toggle('hidden', name !== 'login');
  document.getElementById('view-app').classList.toggle('hidden', name !== 'app');
}

function enterAppShell() {
  showView('app');
  renderSidebar();
  renderUserSummary();
  renderTopbarContext();
  subscribeToActiveTermChanges();

  history.replaceState({ viewKey: 'dashboard' }, '', '#dashboard');
  navigateTo('dashboard', true);

  const pendingRc = sessionStorage.getItem('pendingReportCardId');
  if (pendingRc) {
    sessionStorage.removeItem('pendingReportCardId');
    openReportCardPreview(pendingRc);
  }
}

/* ----------------------------------------------------------------------------
   LOGIN PANEL SWITCHING — sign in / create account / contact / reset.
   There is no "Activate your account" panel here: that is a staff flow.
   ---------------------------------------------------------------------------- */
function showLoginPanel(panel) {
  document.getElementById('signin-form-card').classList.toggle('hidden', panel !== 'signin');
  document.getElementById('register-form-card').classList.toggle('hidden', panel !== 'register');
  document.getElementById('contact-form-card').classList.toggle('hidden', panel !== 'contact');
  document.getElementById('reset-form-card').classList.toggle('hidden', panel !== 'reset');
}
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
    // SECURITY: the name and phone travel as auth metadata, and the DATABASE
    // decides the role. This used to be an insert with role: 'parent' written
    // in the browser, which anyone could change to 'admin' before sending it.
    // Nothing here can influence permissions any more — the worst a forged
    // request can do now is set its own display name.
    const { data: signUpData, error: signUpErr } = await supabaseClient.auth.signUp({
      email,
      password,
      options: { data: { full_name: fullName, phone } },
    });
    if (signUpErr) throw signUpErr;
    const authUser = signUpData.user;
    if (!authUser) throw new Error('Could not create your account. Please try again.');

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


/* ----------------------------------------------------------------------------
   SCREEN DISPATCH
   ---------------------------------------------------------------------------- */
const VIEW_LOAD_HANDLERS = {
  dashboard: loadParentDashboard,
  students: loadStudentsScreen,
  reportcards: loadReportCardsScreen,
  announcements: loadAnnouncementsScreen,
  profile: loadProfileScreen,
};

/* ----------------------------------------------------------------------------
   A child, with the class/stream and programme (Nursery or Primary) worked
   out from the class name — there is no separate "programme" column, so it's
   read off the front of whatever the class is called (e.g. "Primary 3" ->
   programme "Primary", stream "Primary 3A").
   ---------------------------------------------------------------------------- */
function programmeFromClassName(className) {
  if (!className) return '\u2014';
  const lower = className.toLowerCase();
  if (lower.includes('nursery') || lower.includes('creche') || lower.includes('pre-nursery')) return 'Nursery';
  if (lower.includes('primary')) return 'Primary';
  return className;
}

let _childrenCache = null;

async function fetchChildrenWithClassInfo(forceRefresh = false) {
  if (_childrenCache && !forceRefresh) return _childrenCache;

  const { data: children } = await supabaseClient
    .from('students')
    .select('id, full_name, admission_number')
    .eq('parent_id', appState.user.id)
    .order('full_name');

  if (!children || children.length === 0) {
    _childrenCache = [];
    return _childrenCache;
  }

  const childIds = children.map(c => c.id);

  let enrollmentsQuery = supabaseClient
    .from('enrollments')
    .select('student_id, classes(name), class_arms(name)')
    .in('student_id', childIds)
    .neq('status', 'withdrawn');
  if (appState.activeTermId) enrollmentsQuery = enrollmentsQuery.eq('term_id', appState.activeTermId);
  const { data: enrollments } = await enrollmentsQuery;

  const byStudent = {};
  (enrollments || []).forEach(e => { byStudent[e.student_id] = e; });

  const { data: cards } = await supabaseClient
    .from('report_cards')
    .select('id, student_id, created_at')
    .in('student_id', childIds)
    .not('published_at', 'is', null)
    .order('created_at', { ascending: false });

  const latestCardByStudent = {};
  (cards || []).forEach(c => { if (!latestCardByStudent[c.student_id]) latestCardByStudent[c.student_id] = c.id; });

  _childrenCache = children.map(c => {
    const e = byStudent[c.id];
    const className = e?.classes?.name || null;
    const armName = e?.class_arms?.name || '';
    return {
      id: c.id,
      full_name: c.full_name,
      admission_number: c.admission_number,
      stream: className ? `${className}${armName}` : '\u2014',
      programme: programmeFromClassName(className),
      latest_report_card_id: latestCardByStudent[c.id] || null,
    };
  });

  return _childrenCache;
}

function childInitials(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase() || '?';
}

function openChildReportCard(childId, latestCardId) {
  if (latestCardId) {
    openReportCardPreview(latestCardId);
  } else {
    navigateTo('reportcards');
  }
}

/* ----------------------------------------------------------------------------
   DASHBOARD — a parent's own summary: their children, how many published
   report cards are waiting, and the latest announcement.
   ---------------------------------------------------------------------------- */
async function loadParentDashboard() {
  const container = document.getElementById('dashboard-analytics');
  container.innerHTML = '<div class="card card-notice"><p>Loading\u2026</p></div>';

  const children = await fetchChildrenWithClassInfo(true);

  if (children.length === 0) {
    container.innerHTML = `
      <div class="card card-notice">
        <p>No children are linked to your account yet. If you have just registered,
        contact the school office with your child's admission number to have them linked.</p>
      </div>`;
    return;
  }

  const [{ data: parentRow }, { data: announcements }] = await Promise.all([
    supabaseClient.from('parents').select('address').eq('id', appState.user.id).maybeSingle(),
    supabaseClient.from('announcements').select('title, body, created_at')
      .order('created_at', { ascending: false }).limit(1),
  ]);

  const publishedCount = children.filter(c => c.latest_report_card_id).length;
  const latestAnnouncement = (announcements || [])[0];
  const greeting = new Date().getHours() < 12 ? 'Good morning' : new Date().getHours() < 17 ? 'Good afternoon' : 'Good evening';
  const todayStr = new Date().toLocaleDateString(undefined, { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });

  container.innerHTML = `
    <div class="pg-banner">
      <div>
        <h2>${greeting}, ${escapeHtml(appState.user.full_name)}!</h2>
        <p>Here is a quick overview of your children's academic progress and school activities.</p>
      </div>
      <span class="pg-banner-date">${todayStr}</span>
    </div>

    <div class="pg-stat-grid">
      <div class="pg-stat-card">
        <span class="pg-stat-icon">\u25C6</span>
        <div>
          <div class="pg-stat-label">Registered Children</div>
          <div class="pg-stat-value">${children.length}</div>
        </div>
      </div>
      <div class="pg-stat-card">
        <span class="pg-stat-icon pg-stat-icon-accent">\u2713</span>
        <div>
          <div class="pg-stat-label">Academic Activities</div>
          <div class="pg-stat-value pg-stat-value-accent">${appState.activeTermId ? 'Active' : 'Inactive'}</div>
        </div>
      </div>
    </div>

    <div class="pg-columns">
      <div class="card pg-profile-card">
        <h2 class="card-title">Guardian Profile</h2>
        <div class="pg-avatar-row">
          <span class="pg-avatar">${childInitials(appState.user.full_name)}</span>
          <div>
            <div class="pg-avatar-name">${escapeHtml(appState.user.full_name)}</div>
            <div class="pg-avatar-role">Parent / Guardian</div>
          </div>
        </div>
        <dl class="pg-detail-list">
          <div><dt>Email</dt><dd>${escapeHtml(appState.user.email || '\u2014')}</dd></div>
          <div><dt>Phone</dt><dd>${escapeHtml(appState.user.phone || '\u2014')}</dd></div>
        </dl>
        ${parentRow?.address ? `
          <div class="pg-address-block">
            <span class="pg-detail-label">Residential Address</span>
            <p>${escapeHtml(parentRow.address)}</p>
          </div>` : ''}
      </div>

      <div class="card pg-linked-card">
        <div class="card-title-row">
          <h2 class="card-title">Linked Students / Wards</h2>
          <button type="button" class="icon-btn" data-goto="students">View All</button>
        </div>
        <table class="data-table pg-linked-table">
            <thead>
              <tr><th>S/N</th><th>Student Name</th><th>Adm. No.</th><th>Class/Stream</th><th>Programme</th><th>Action</th></tr>
            </thead>
            <tbody>
              ${children.map((c, i) => `
                <tr>
                  <td>${i + 1}</td>
                  <td>
                    <div class="pg-student-cell">
                      <span class="pg-mini-avatar">${childInitials(c.full_name)}</span>
                      <span>${escapeHtml(c.full_name)}</span>
                    </div>
                  </td>
                  <td><span class="badge">${escapeHtml(c.admission_number || '\u2014')}</span></td>
                  <td>${escapeHtml(c.stream)}</td>
                  <td>${escapeHtml(c.programme)}</td>
                  <td>
                    <button type="button" class="btn btn-primary btn-sm pg-view-result-btn"
                      data-student="${c.id}" data-card="${c.latest_report_card_id || ''}">View Result</button>
                  </td>
                </tr>`).join('')}
            </tbody>
          </table>
      </div>
    </div>

    ${latestAnnouncement ? `
      <div class="card">
        <div class="card-title-row">
          <h2 class="card-title">Latest announcement</h2>
          <button type="button" class="icon-btn" data-goto="announcements">See all</button>
        </div>
        <h3 style="font-size:15px;margin-bottom:6px;">${escapeHtml(latestAnnouncement.title)}</h3>
        <p>${escapeHtml(latestAnnouncement.body)}</p>
        <p class="view-subheading">${new Date(latestAnnouncement.created_at).toLocaleDateString()}</p>
      </div>` : ''}
  `;

  container.querySelectorAll('[data-goto]').forEach(btn => {
    btn.addEventListener('click', () => navigateTo(btn.dataset.goto));
  });
  container.querySelectorAll('.pg-view-result-btn').forEach(btn => {
    btn.addEventListener('click', () => openChildReportCard(btn.dataset.student, btn.dataset.card || null));
  });
}

/* ----------------------------------------------------------------------------
   STUDENTS — "My Children": full table with a search box and a filter for
   Nursery / Primary, matching the school's reference layout.
   ---------------------------------------------------------------------------- */
async function loadStudentsScreen() {
  document.getElementById('students-subheading').textContent =
    'Here is a list of your children\u2019s academic progress and school activities.';
  const container = document.getElementById('students-content');
  container.innerHTML = '<div class="card card-notice"><p>Loading\u2026</p></div>';

  const children = await fetchChildrenWithClassInfo();

  if (children.length === 0) {
    container.innerHTML = `<div class="card card-notice"><p>No children are linked to your account yet.
      Contact the school office with your child's admission number to have them linked.</p></div>`;
    return;
  }

  let filter = 'all';
  let search = '';

  function render() {
    const rows = children.filter(c => {
      const matchesFilter = filter === 'all' || c.programme.toLowerCase() === filter;
      const matchesSearch = !search || c.full_name.toLowerCase().includes(search) ||
        (c.admission_number || '').toLowerCase().includes(search);
      return matchesFilter && matchesSearch;
    });

    container.innerHTML = `
      <div class="pg-toolbar">
        <div class="pg-filter-tabs" role="tablist">
          <button type="button" class="pg-filter-tab ${filter === 'all' ? 'active' : ''}" data-filter="all">All</button>
          <button type="button" class="pg-filter-tab ${filter === 'nursery' ? 'active' : ''}" data-filter="nursery">Nursery</button>
          <button type="button" class="pg-filter-tab ${filter === 'primary' ? 'active' : ''}" data-filter="primary">Primary</button>
        </div>
        <div class="pg-search-box">
          <span aria-hidden="true">\u26B2</span>
          <input type="search" id="students-search-input" placeholder="Search your children\u2026" value="${escapeHtml(search)}">
        </div>
      </div>

      <div class="card">
        <table class="data-table pg-linked-table">
            <thead>
              <tr><th>S/N</th><th>Student Name</th><th>Adm. No.</th><th>Class/Stream</th><th>Programme</th><th>Action</th></tr>
            </thead>
            <tbody>
              ${rows.length ? rows.map((c, i) => `
                <tr>
                  <td>${i + 1}</td>
                  <td>
                    <div class="pg-student-cell">
                      <span class="pg-mini-avatar">${childInitials(c.full_name)}</span>
                      <span>${escapeHtml(c.full_name)}</span>
                    </div>
                  </td>
                  <td><span class="badge">${escapeHtml(c.admission_number || '\u2014')}</span></td>
                  <td>${escapeHtml(c.stream)}</td>
                  <td>${escapeHtml(c.programme)}</td>
                  <td>
                    <button type="button" class="btn btn-primary btn-sm pg-view-result-btn"
                      data-student="${c.id}" data-card="${c.latest_report_card_id || ''}">View Result</button>
                  </td>
                </tr>`).join('') : `<tr><td colspan="6" class="pg-empty-row">No children match that search.</td></tr>`}
            </tbody>
          </table>
        <p class="pg-showing-count">Showing ${rows.length} of ${children.length} ${children.length === 1 ? 'entry' : 'entries'}</p>
      </div>
    `;

    container.querySelectorAll('.pg-filter-tab').forEach(btn => {
      btn.addEventListener('click', () => { filter = btn.dataset.filter; render(); });
    });
    const input = document.getElementById('students-search-input');
    input.addEventListener('input', () => { search = input.value.trim().toLowerCase(); render(); });
    input.focus({ preventScroll: true });
    input.setSelectionRange(input.value.length, input.value.length);
    container.querySelectorAll('.pg-view-result-btn').forEach(btn => {
      btn.addEventListener('click', () => openChildReportCard(btn.dataset.student, btn.dataset.card || null));
    });
  }

  render();
}

/* ----------------------------------------------------------------------------
   PROFILE — the guardian's own details, read-only.
   ---------------------------------------------------------------------------- */
async function loadProfileScreen() {
  const container = document.getElementById('profile-content');
  container.innerHTML = '<div class="card card-notice"><p>Loading\u2026</p></div>';

  const { data: parentRow } = await supabaseClient
    .from('parents').select('address').eq('id', appState.user.id).maybeSingle();
  const children = await fetchChildrenWithClassInfo();

  container.innerHTML = `
    <div class="card pg-profile-card pg-profile-card-standalone">
      <div class="pg-avatar-row">
        <span class="pg-avatar pg-avatar-lg">${childInitials(appState.user.full_name)}</span>
        <div>
          <div class="pg-avatar-name" style="font-size:19px;">${escapeHtml(appState.user.full_name)}</div>
          <div class="pg-avatar-role">Parent / Guardian</div>
        </div>
      </div>
      <dl class="pg-detail-list">
        <div><dt>Email</dt><dd>${escapeHtml(appState.user.email || '\u2014')}</dd></div>
        <div><dt>Phone</dt><dd>${escapeHtml(appState.user.phone || '\u2014')}</dd></div>
        <div><dt>Children linked</dt><dd>${children.length}</dd></div>
      </dl>
      ${parentRow?.address ? `
        <div class="pg-address-block">
          <span class="pg-detail-label">Residential Address</span>
          <p>${escapeHtml(parentRow.address)}</p>
        </div>` : ''}
      <p class="view-subheading" style="margin-top:20px;">To correct any of these details, contact the school office.</p>
    </div>
  `;
}

/* ----------------------------------------------------------------------------
   REPORT CARDS — published cards only, for this parent's own children.
   ---------------------------------------------------------------------------- */
async function loadReportCardsScreen() {
  const container = document.getElementById('reportcards-content');
  document.getElementById('reportcards-subheading').textContent =
    'Every report card the school has published for your children. Open one to read it in full or print it.';
  await renderParentReportCardsScreen(container);
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
   ANNOUNCEMENTS — read only.
   ---------------------------------------------------------------------------- */
async function loadAnnouncementsScreen() {
  const container = document.getElementById('announcements-content');
  document.getElementById('announcements-subheading').textContent = 'Published announcements from the school.';
  await renderReadOnlyAnnouncementsScreen(container);
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

/* ----------------------------------------------------------------------------
   BOOTSTRAP
   ---------------------------------------------------------------------------- */
async function bootstrap() {
  wirePasswordToggles();
  wireSharedLoginEvents();

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

  const rcParam = new URLSearchParams(window.location.search).get('rc');
  if (rcParam) sessionStorage.setItem('pendingReportCardId', rcParam);

  showLoading();
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (session && session.user) {
    await loadUserProfileAndEnterApp(session.user);
  } else {
    await loadSchoolSettings();
    showView('login');
  }
  hideLoading();
}

document.addEventListener('DOMContentLoaded', bootstrap);
