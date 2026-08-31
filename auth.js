/* ---------------------------------------------------------
   auth.js — sign in, sign up, session

   With no key configured the app runs local-only and this
   module stays out of the way entirely.
--------------------------------------------------------- */

let sb = null;          // Supabase client
let currentUser = null;

function initAuth() {
  if (!CLOUD_ENABLED) return;

  sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true }
  });

  $('authForm').onsubmit = submitAuth;
  $('authToggle').onclick = toggleAuthMode;
  $('signOutBtn').onclick = signOut;
  $('topSignOut').onclick = signOut;
}

let authMode = 'signin';

function toggleAuthMode() {
  authMode = authMode === 'signin' ? 'signup' : 'signin';
  const up = authMode === 'signup';
  $('authTitle').textContent = up ? 'Create account' : 'Sign in';
  $('authSubmit').textContent = up ? 'Create account' : 'Sign in';
  $('authToggle').textContent = up
    ? 'Already have an account? Sign in'
    : 'No account? Create one';
  $('nameField').hidden = !up;
  authMsg('');
}

function authMsg(text, tone) {
  const el = $('authMsg');
  el.textContent = text || '';
  el.hidden = !text;
  el.className = 'authmsg ' + (tone || '');
}

async function submitAuth(e) {
  e.preventDefault();

  const email = $('authEmail').value.trim();
  const password = $('authPassword').value;
  if (!email || !password) return;

  $('authSubmit').disabled = true;
  authMsg('Working…');

  try {
    if (authMode === 'signup') {
      const { data, error } = await sb.auth.signUp({
        email,
        password,
        options: {
          data: { full_name: $('authName').value.trim() },
          emailRedirectTo: window.location.origin
        }
      });
      if (error) throw error;

      if (!data.session) {
        authMsg('Check your email and click the confirmation link, then sign in.', 'ok');
        authMode = 'signup';
        toggleAuthMode();
        return;
      }
      await onSignedIn(data.session.user);
    } else {
      const { data, error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
      await onSignedIn(data.session.user);
    }
  } catch (err) {
    authMsg(friendlyAuthError(err), 'bad');
  } finally {
    $('authSubmit').disabled = false;
  }
}

function friendlyAuthError(err) {
  const m = (err && err.message || '').toLowerCase();
  if (m.includes('invalid login')) return 'Wrong email or password.';
  if (m.includes('not confirmed')) return 'Confirm your email first — check your inbox.';
  if (m.includes('already registered')) return 'That email already has an account.';
  if (m.includes('password')) return 'Password must be at least 6 characters.';
  if (m.includes('fetch') || m.includes('network')) return 'No connection. Try again when you are online.';
  return err.message || 'Something went wrong.';
}

// Called after a successful sign in and on a restored session.
async function onSignedIn(user) {
  currentUser = user;

  // A different account on this device must not inherit the
  // previous one's rows.
  const lastUser = await getMeta('userId', null);
  if (lastUser && lastUser !== user.id) {
    await wipeLocal();
  }
  await setMeta('userId', user.id);

  await seed();
  await bootData();

  showApp(true);
  await renderActive();
  await renderAccount();

  syncNow();
}

async function signOut() {
  if (!confirm('Sign out? Local data on this device will be cleared — it stays safe in the cloud.')) return;
  await sb.auth.signOut();
  await wipeLocal();
  currentUser = null;
  location.reload();
}

async function restoreSession() {
  if (!CLOUD_ENABLED) return false;
  const { data } = await sb.auth.getSession();
  if (data.session) {
    await onSignedIn(data.session.user);
    return true;
  }
  return false;
}

function showApp(visible) {
  $('screen-auth').hidden = visible;
  $('appMain').hidden = !visible;
  $('tabs').hidden = !visible;
  $('topbar').hidden = !visible;
  $('topSignOut').hidden = !(visible && CLOUD_ENABLED);
}

async function renderAccount() {
  if (!CLOUD_ENABLED) {
    $('accountCard').hidden = true;
    return;
  }
  $('accountCard').hidden = false;
  $('accountEmail').textContent = currentUser ? currentUser.email : '—';
}
