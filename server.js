const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

// ------------------------------------
// Supabase clients
// ------------------------------------
// Service-role client for admin operations (user management, storage, etc.)
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Anon client for auth operations (magic links use anon key)
const supabaseAuth = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// ------------------------------------
// Middleware
// ------------------------------------
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: false
}));
app.use(compression());
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Rate limit magic link requests
const magicLinkLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: 'Too many login attempts. Please try again in 15 minutes.',
  standardHeaders: true,
  legacyHeaders: false
});

// ------------------------------------
// Session middleware — verifies Supabase JWT from cookie
// ------------------------------------
async function requireAuth(req, res, next) {
  const accessToken = req.cookies.sb_access_token;
  const refreshToken = req.cookies.sb_refresh_token;

  if (!accessToken) {
    return res.redirect('/login');
  }

  try {
    // Verify the session with Supabase
    const { data: { user }, error } = await supabaseAuth.auth.getUser(accessToken);

    if (error || !user) {
      // Try refreshing the session
      if (refreshToken) {
        const { data: refreshData, error: refreshError } = await supabaseAuth.auth.refreshSession({
          refresh_token: refreshToken
        });

        if (!refreshError && refreshData.session) {
          // Set new cookies
          setAuthCookies(res, refreshData.session);
          req.user = refreshData.session.user;

          // Load partner record
          const partner = await getPartnerByEmail(req.user.email);
          if (!partner) {
            clearAuthCookies(res);
            return res.redirect('/login?error=not_authorized');
          }
          req.partner = partner;
          return next();
        }
      }

      clearAuthCookies(res);
      return res.redirect('/login?error=session_expired');
    }

    req.user = user;

    // Verify user is an allowlisted partner
    const partner = await getPartnerByEmail(user.email);
    if (!partner) {
      clearAuthCookies(res);
      return res.redirect('/login?error=not_authorized');
    }
    req.partner = partner;

    next();
  } catch (err) {
    console.error('Auth middleware error:', err.message);
    clearAuthCookies(res);
    res.redirect('/login');
  }
}

function setAuthCookies(res, session) {
  const cookieOpts = {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
  };

  res.cookie('sb_access_token', session.access_token, cookieOpts);
  res.cookie('sb_refresh_token', session.refresh_token, cookieOpts);
}

function clearAuthCookies(res) {
  res.clearCookie('sb_access_token');
  res.clearCookie('sb_refresh_token');
}

// Look up partner by email in dashboard_partners table
async function getPartnerByEmail(email) {
  const { data, error } = await supabaseAdmin
    .from('dashboard_partners')
    .select('*')
    .eq('email', email.toLowerCase())
    .eq('is_active', true)
    .single();

  if (error || !data) return null;
  return data;
}

// ------------------------------------
// Auth routes
// ------------------------------------

// Login page — step 1: enter email, step 2: enter code
app.get('/login', (req, res) => {
  const error = req.query.error || null;
  const step = req.query.step || 'email';
  const email = req.query.email || '';

  const errorMessages = {
    not_authorized: 'This email is not authorized for dashboard access.',
    session_expired: 'Your session has expired. Please log in again.',
    send_failed: 'Failed to send verification code. Please try again.',
    invalid_code: 'Invalid or expired code. Please try again.',
    verify_failed: 'Verification failed. Please try again.'
  };

  res.render('login', {
    error: error ? (errorMessages[error] || error) : null,
    step,
    email
  });
});

// Step 1: Send OTP code to email
app.post('/login/send', magicLinkLimiter, async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();

  if (!email || !email.includes('@')) {
    return res.redirect('/login?error=Please enter a valid email address');
  }

  // Check if email is allowlisted BEFORE sending
  const partner = await getPartnerByEmail(email);
  if (!partner) {
    // Don't reveal whether the email exists — show the code entry screen anyway
    return res.redirect(`/login?step=code&email=${encodeURIComponent(email)}`);
  }

  try {
    const { error } = await supabaseAuth.auth.signInWithOtp({
      email,
      options: {
        shouldCreateUser: true
      }
    });

    if (error) {
      console.error('OTP send error:', error.message);
      return res.redirect('/login?error=send_failed');
    }

    res.redirect(`/login?step=code&email=${encodeURIComponent(email)}`);
  } catch (err) {
    console.error('Login error:', err.message);
    res.redirect('/login?error=send_failed');
  }
});

// Step 2: Verify OTP code
app.post('/login/verify', async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const code = (req.body.code || '').trim();

  if (!email || !code) {
    return res.redirect(`/login?step=code&email=${encodeURIComponent(email)}&error=invalid_code`);
  }

  try {
    const { data, error } = await supabaseAuth.auth.verifyOtp({
      email,
      token: code,
      type: 'email'
    });

    if (error || !data.session) {
      console.error('OTP verify error:', error?.message);
      return res.redirect(`/login?step=code&email=${encodeURIComponent(email)}&error=invalid_code`);
    }

    // Verify partner access
    const partner = await getPartnerByEmail(email);
    if (!partner) {
      return res.redirect('/login?error=not_authorized');
    }

    setAuthCookies(res, data.session);
    res.redirect('/');
  } catch (err) {
    console.error('Verify error:', err.message);
    res.redirect(`/login?step=code&email=${encodeURIComponent(email)}&error=verify_failed`);
  }
});

// Logout
app.get('/logout', (req, res) => {
  clearAuthCookies(res);
  res.redirect('/login');
});

// ------------------------------------
// Protected routes
// ------------------------------------

// Import route modules
const dashboardRoutes = require('./routes/dashboard');
const usersRoutes = require('./routes/users');

app.use('/', requireAuth, dashboardRoutes);
app.use('/users', requireAuth, usersRoutes);

// ------------------------------------
// Error handling
// ------------------------------------
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message);
  res.status(500).render('error', { message: 'Something went wrong.' });
});

app.use((req, res) => {
  res.status(404).render('error', { message: 'Page not found.' });
});

// ------------------------------------
// Start
// ------------------------------------
app.listen(PORT, () => {
  console.log(`🖥️  Aquamark Broker Partner Dashboard on port ${PORT}`);
});
