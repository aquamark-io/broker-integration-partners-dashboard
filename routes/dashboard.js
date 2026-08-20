const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Dashboard home
router.get('/', async (req, res) => {
  try {
    const partner = req.partner;

    // Get current and previous month
    const now = new Date();
    const currentMonth = now.getMonth() + 1;
    const currentYear = now.getFullYear();
    const prevMonth = currentMonth === 1 ? 12 : currentMonth - 1;
    const prevYear = currentMonth === 1 ? currentYear - 1 : currentYear;

    // Fetch broker users for this partner
    const { data: users, error: usersError } = await supabaseAdmin
      .from('broker_users')
      .select('user_email, company_name, is_active, created_at')
      .eq('partner_id', partner.id)
      .order('company_name', { ascending: true });

    if (usersError) {
      console.error('Error fetching users:', usersError.message);
    }

    const brokerUsers = users || [];
    const activeCount = brokerUsers.filter(u => u.is_active).length;

    // Fetch usage for current month
    const { data: currentUsage } = await supabaseAdmin
      .from('broker_monthly_usage')
      .select('user_email, file_count, page_count')
      .in('user_email', brokerUsers.map(u => u.user_email))
      .eq('month', currentMonth)
      .eq('year', currentYear);

    // Fetch usage for previous month
    const { data: prevUsage } = await supabaseAdmin
      .from('broker_monthly_usage')
      .select('user_email, file_count, page_count')
      .in('user_email', brokerUsers.map(u => u.user_email))
      .eq('month', prevMonth)
      .eq('year', prevYear);

    // Aggregate usage
    const currentTotals = aggregateUsage(currentUsage || []);
    const prevTotals = aggregateUsage(prevUsage || []);

    // Per-user usage for current month
    const userUsageMap = {};
    (currentUsage || []).forEach(u => {
      userUsageMap[u.user_email] = { files: u.file_count, pages: u.page_count };
    });

    // Per-user usage for previous month
    const prevUserUsageMap = {};
    (prevUsage || []).forEach(u => {
      prevUserUsageMap[u.user_email] = { files: u.file_count, pages: u.page_count };
    });

    res.render('dashboard', {
      partner,
      brokerUsers,
      activeCount,
      currentMonth,
      currentYear,
      prevMonth,
      prevYear,
      userUsageMap,
      prevUserUsageMap,
      apiKey: partner.api_key
    });
  } catch (err) {
    console.error('Dashboard error:', err.message);
    res.status(500).render('error', { message: 'Failed to load dashboard.' });
  }
});

function aggregateUsage(usageRows) {
  return usageRows.reduce(
    (acc, row) => ({
      files: acc.files + (row.file_count || 0),
      pages: acc.pages + (row.page_count || 0)
    }),
    { files: 0, pages: 0 }
  );
}

// Month name helper
function monthName(m) {
  const names = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return names[m] || '';
}

module.exports = router;
