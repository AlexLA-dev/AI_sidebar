-- =============================================
-- ContextFlow: App Store Subscription Support
-- Run this migration AFTER SUPABASE_SETUP.sql
-- =============================================

-- Add payment provider column to track where the subscription originated
ALTER TABLE public.user_subscriptions
  ADD COLUMN IF NOT EXISTS payment_provider TEXT
    CHECK (payment_provider IN ('stripe', 'appstore'))
    DEFAULT NULL;

-- Add App Store original transaction ID for matching App Store Server Notifications
ALTER TABLE public.user_subscriptions
  ADD COLUMN IF NOT EXISTS appstore_original_transaction_id TEXT UNIQUE DEFAULT NULL;

-- Index for fast lookups by App Store transaction ID
CREATE INDEX IF NOT EXISTS idx_user_subscriptions_appstore_txn
  ON public.user_subscriptions(appstore_original_transaction_id)
  WHERE appstore_original_transaction_id IS NOT NULL;

-- Comment the new columns for documentation
COMMENT ON COLUMN public.user_subscriptions.payment_provider IS
  'Payment provider: stripe (Chrome/web) or appstore (Safari/iOS via StoreKit)';

COMMENT ON COLUMN public.user_subscriptions.appstore_original_transaction_id IS
  'StoreKit 2 originalTransactionId for linking App Store Server Notifications to users';
