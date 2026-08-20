const express = require('express');
const router = express.Router();
const multer = require('multer');
const sharp = require('sharp');
const { createClient } = require('@supabase/supabase-js');

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Multer for logo uploads (memory storage, 5MB max)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  }
});

// ------------------------------------
// List all broker users (JSON for AJAX)
// ------------------------------------
router.get('/list', async (req, res) => {
  try {
    const { data: users, error } = await supabaseAdmin
      .from('broker_users')
      .select('*')
      .eq('partner_id', req.partner.id)
      .order('company_name', { ascending: true });

    if (error) throw error;
    res.json({ users: users || [] });
  } catch (err) {
    console.error('List users error:', err.message);
    res.status(500).json({ error: 'Failed to load users' });
  }
});

// ------------------------------------
// Add new broker user
// ------------------------------------
router.post('/add', upload.single('logo'), async (req, res) => {
  try {
    const { user_email, company_name } = req.body;

    if (!user_email || !user_email.includes('@')) {
      return res.status(400).json({ error: 'Valid email address is required' });
    }
    if (!company_name || company_name.trim().length === 0) {
      return res.status(400).json({ error: 'Company name is required' });
    }

    const email = user_email.trim().toLowerCase();

    // Check if user already exists
    const { data: existing } = await supabaseAdmin
      .from('broker_users')
      .select('user_email')
      .eq('user_email', email)
      .single();

    if (existing) {
      return res.status(409).json({ error: 'A user with this email already exists' });
    }

    // Insert user
    const { error: insertError } = await supabaseAdmin
      .from('broker_users')
      .insert({
        user_email: email,
        company_name: company_name.trim(),
        partner_id: req.partner.id,
        is_active: true,
        created_at: new Date().toISOString()
      });

    if (insertError) throw insertError;

    // Upload logo if provided
    if (req.file) {
      await processAndUploadLogo(email, req.file.buffer);
    }

    res.json({ success: true, message: 'Broker user created successfully' });

    // Send email notification (fire and forget — don't block the response)
    if (process.env.POSTMARK_API_TOKEN) {
      fetch('https://api.postmarkapp.com/email', {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'X-Postmark-Server-Token': process.env.POSTMARK_API_TOKEN
        },
        body: JSON.stringify({
          From: 'christina@aquamark.io',
          To: 'christina@aquamark.io',
          Subject: `New Broker User Added — ${req.partner.company_name}`,
          TextBody: `${req.partner.company_name} added a new broker user:\n\nEmail: ${email}\nCompany: ${company_name.trim()}\nLogo: ${req.file ? 'Yes' : 'No'}\nTime: ${new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })}`
        })
      }).catch(err => console.error('Notification email failed:', err.message));
    }
  } catch (err) {
    console.error('Add user error:', err.message);
    res.status(500).json({ error: 'Failed to create user: ' + err.message });
  }
});

// ------------------------------------
// Update broker user
// ------------------------------------
router.post('/update', upload.single('logo'), async (req, res) => {
  try {
    const { user_email, company_name, is_active } = req.body;

    if (!user_email) {
      return res.status(400).json({ error: 'User email is required' });
    }

    // Verify user belongs to this partner
    const { data: user, error: fetchError } = await supabaseAdmin
      .from('broker_users')
      .select('*')
      .eq('user_email', user_email)
      .eq('partner_id', req.partner.id)
      .single();

    if (fetchError || !user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Build update object
    const updates = {};
    if (company_name !== undefined) updates.company_name = company_name.trim();
    if (is_active !== undefined) updates.is_active = is_active === 'true' || is_active === true;

    if (Object.keys(updates).length > 0) {
      const { error: updateError } = await supabaseAdmin
        .from('broker_users')
        .update(updates)
        .eq('user_email', user_email);

      if (updateError) throw updateError;
    }

    // Upload new logo if provided
    if (req.file) {
      await processAndUploadLogo(user_email, req.file.buffer);
    }

    res.json({ success: true, message: 'User updated successfully' });
  } catch (err) {
    console.error('Update user error:', err.message);
    res.status(500).json({ error: 'Failed to update user: ' + err.message });
  }
});

// ------------------------------------
// Get logo URL for a user
// ------------------------------------
router.get('/logo/:email', async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email);

    // Verify user belongs to this partner
    const { data: user } = await supabaseAdmin
      .from('broker_users')
      .select('user_email')
      .eq('user_email', email)
      .eq('partner_id', req.partner.id)
      .single();

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const { data: files } = await supabaseAdmin.storage
      .from('broker-logos')
      .list(email);

    if (files && files.length > 0) {
      const latest = files.sort((a, b) => b.name.localeCompare(a.name))[0];
      const { data } = await supabaseAdmin.storage
        .from('broker-logos')
        .createSignedUrl(`${email}/${latest.name}`, 3600);

      if (data?.signedUrl) {
        return res.json({ url: data.signedUrl });
      }
    }

    res.json({ url: null });
  } catch (err) {
    console.error('Logo fetch error:', err.message);
    res.status(500).json({ error: 'Failed to get logo' });
  }
});

// ------------------------------------
// Usage detail for a specific user
// ------------------------------------
router.get('/usage/:email', async (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email);

    // Verify user belongs to this partner
    const { data: user } = await supabaseAdmin
      .from('broker_users')
      .select('user_email')
      .eq('user_email', email)
      .eq('partner_id', req.partner.id)
      .single();

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Get last 6 months of usage
    const { data: usage, error } = await supabaseAdmin
      .from('broker_monthly_usage')
      .select('month, year, file_count, page_count')
      .eq('user_email', email)
      .order('year', { ascending: false })
      .order('month', { ascending: false })
      .limit(6);

    if (error) throw error;
    res.json({ usage: usage || [] });
  } catch (err) {
    console.error('Usage fetch error:', err.message);
    res.status(500).json({ error: 'Failed to get usage' });
  }
});

// ------------------------------------
// Helper: process and upload logo
// ------------------------------------
async function processAndUploadLogo(userEmail, imageBuffer) {
  // Resize and convert to PNG, max 400x400
  const processed = await sharp(imageBuffer)
    .resize(400, 400, { fit: 'inside', withoutEnlargement: true })
    .png({ quality: 90 })
    .toBuffer();

  const timestamp = Date.now();
  const storagePath = `${userEmail}/logo-${timestamp}.png`;

  // Delete any existing logos for this user
  const { data: existingFiles } = await supabaseAdmin.storage
    .from('broker-logos')
    .list(userEmail);

  if (existingFiles && existingFiles.length > 0) {
    const filesToRemove = existingFiles.map(f => `${userEmail}/${f.name}`);
    await supabaseAdmin.storage
      .from('broker-logos')
      .remove(filesToRemove);
  }

  // Upload new logo
  const { error } = await supabaseAdmin.storage
    .from('broker-logos')
    .upload(storagePath, processed, {
      contentType: 'image/png'
    });

  if (error) {
    throw new Error('Logo upload failed: ' + error.message);
  }
}

module.exports = router;
