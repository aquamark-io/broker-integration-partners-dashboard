-- ============================================
-- Aquamark Broker Partner Dashboard — Database Setup
-- Run this in Supabase SQL Editor
-- ============================================
-- Note: this shares the same Supabase project and the same
-- dashboard_partners table as the funder partner dashboard.
-- Do NOT recreate dashboard_partners here — it already exists.

-- 1. Add partner_id to broker_users (links broker users to their managing partner)
-- Skip if column already exists
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'broker_users' AND column_name = 'partner_id'
  ) THEN
    ALTER TABLE broker_users ADD COLUMN partner_id UUID REFERENCES dashboard_partners(id);
  END IF;
END $$;

-- Index for partner-scoped queries
CREATE INDEX IF NOT EXISTS idx_broker_users_partner_id 
  ON broker_users (partner_id);

-- 2. Link an existing partner's broker users
-- Run this AFTER confirming the partner row exists in dashboard_partners
-- (reuse the same partner row as the funder dashboard if it's the same partner)
-- UPDATE broker_users 
-- SET partner_id = (SELECT id FROM dashboard_partners WHERE company_name = 'SmartMCA')
-- WHERE user_email IN ('broker1@example.com', 'broker2@example.com');

-- ============================================
-- Supabase Storage note:
-- Create a "broker-logos" storage bucket in the Supabase dashboard
-- (Storage → New bucket), matching the existing "funder-logos" bucket setup.
-- ============================================
