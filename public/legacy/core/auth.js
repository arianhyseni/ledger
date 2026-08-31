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
  $('saveProfile').onclick = saveProfileName;
  $('changePw').onclick = changePassword;
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

  showApp(true);

  // Pull before seeding. On a second device the account already has
  // its categories, and seeding first would duplicate all of them.
  // Seeding only fills a genuinely empty account.
  const synced = CLOUD_ENABLED ? await syncNow() : false;
  if (!CLOUD_ENABLED || synced) await seed();

  await bootData();
  await renderActive();
  await renderAccount();

  if (CLOUD_ENABLED && synced) scheduleSync(1000);
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

/* ---------- profile ---------- */

let profile = null;

// Two letters from the name, or the first two of the email.
function initialsFor(name, email) {
  const src = (name || '').trim();
  if (src) {
    const parts = src.split(/\s+/).filter(Boolean);
    return (parts.length > 1
      ? parts[0][0] + parts[parts.length - 1][0]
      : parts[0].slice(0, 2)).toUpperCase();
  }
  return (email || '?').slice(0, 2).toUpperCase();
}

// A stable colour per account, so the avatar is recognisable
// without anyone having to upload anything.
function avatarHue(seed) {
  let h = 0;
  for (const ch of String(seed)) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

async function loadProfile() {
  if (!currentUser) return null;
  try {
    const { data, error } = await sb
      .from('profiles').select('*').eq('id', currentUser.id).single();
    if (error) throw error;
    profile = data;
  } catch (err) {
    // Offline, or the row has not replicated yet — fall back to the
    // session, which already carries the signup metadata.
    profile = {
      id: currentUser.id,
      email: currentUser.email,
      full_name: (currentUser.user_metadata || {}).full_name || ''
    };
  }
  return profile;
}

async function saveProfileName() {
  const full_name = $('profName').value.trim();
  $('saveProfile').disabled = true;
  try {
    const { error } = await sb
      .from('profiles').update({ full_name }).eq('id', currentUser.id);
    if (error) throw error;
    profile.full_name = full_name;
    paintProfile();
    toast('Name updated.');
  } catch (err) {
    toast('Could not save: ' + (err.message || 'no connection'));
  } finally {
    $('saveProfile').disabled = false;
  }
}

async function changePassword() {
  const a = $('pw1').value, b = $('pw2').value;
  const msg = (text, tone) => {
    const el = $('pwMsg');
    el.textContent = text;
    el.hidden = !text;
    el.className = 'hint ' + (tone || '');
  };

  if (a.length < 6)  { msg('Password must be at least 6 characters.', 'bad'); return; }
  if (a !== b)       { msg('The two passwords do not match.', 'bad'); return; }

  $('changePw').disabled = true;
  msg('Working…');
  try {
    const { error } = await sb.auth.updateUser({ password: a });
    if (error) throw error;
    $('pw1').value = '';
    $('pw2').value = '';
    msg('Password changed. It applies on your next sign in.', 'ok');
  } catch (err) {
    msg(friendlyAuthError(err), 'bad');
  } finally {
    $('changePw').disabled = false;
  }
}

function paintProfile() {
  const name  = profile ? (profile.full_name || '') : '';
  const email = currentUser ? currentUser.email : '';

  $('accountName').textContent  = name || 'No name set';
  $('accountEmail').textContent = email;
  $('profName').value = name;

  const av = $('avatar');
  av.textContent = initialsFor(name, email);
  const hue = avatarHue(currentUser ? currentUser.id : email);
  av.style.background = `hsl(${hue} 42% 92%)`;
  av.style.color = `hsl(${hue} 55% 28%)`;
}

async function renderAccount() {
  if (!CLOUD_ENABLED) {
    $('accountCard').hidden = true;
    return;
  }
  $('accountCard').hidden = false;
  await loadProfile();
  paintProfile();
}
