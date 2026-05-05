export type SubscriptionPlanId = "free" | "lite" | "plus" | "pro" | "max";
export type SubscriptionTierId = SubscriptionPlanId | "customize";
export type PaidSubscriptionPlanId = Exclude<SubscriptionTierId, "free">;
export type SubscriptionStatus =
  | "inactive"
  | "trialing"
  | "active"
  | "ended_renewed"
  | "ended_not_renewed"
  | "ended_changed_plan"
  | "ended_refunded"
  | "revoked";
export type SubscriptionBillingInterval = "monthly";
export type SubscriptionStorePlatform = "ios" | "android";
export type SubscriptionStoreEnvironment = "sandbox" | "production";
export type SubscriptionProvider =
  | "special"
  | "apple_iap"
  | "google_iap"
  | "stripe"
  | "wechat_pay";

export const CUSTOMIZE_DEFAULT_MAX_HOSTS = 50;

export const SUBSCRIPTION_PLAN_CODE_BY_ID: Record<SubscriptionTierId, number> = {
  free: 0,
  lite: 1,
  plus: 2,
  pro: 3,
  max: 4,
  customize: 9
};

export const SUBSCRIPTION_PROVIDER_CODE_BY_ID: Record<SubscriptionProvider, number> = {
  special: 0,
  apple_iap: 1,
  google_iap: 2,
  stripe: 3,
  wechat_pay: 4
};

export const SUBSCRIPTION_STATUS_CODE_BY_ID: Record<SubscriptionStatus, number> = {
  inactive: 0,
  active: 1,
  ended_renewed: 2,
  ended_not_renewed: 3,
  ended_changed_plan: 4,
  ended_refunded: 5,
  trialing: 6,
  revoked: 7
};

export interface SubscriptionPlanDefinition {
  id: SubscriptionPlanId;
  monthlyPriceUsd: number;
  relayHosts: number;
  gridOrder: number;
  mostPopular?: boolean;
  trialDays?: number;
}

export interface SubscriptionStoreProductDefinition {
  tier: Exclude<SubscriptionPlanId, "free">;
  provider: Extract<SubscriptionProvider, "apple_iap" | "google_iap">;
  platform: SubscriptionStorePlatform;
  productId: string;
  currentPlanId: string;
}

export interface UserSubscription {
  id: string;
  userId: string;
  tier: PaidSubscriptionPlanId;
  planCode: number;
  maxHosts: number;
  status: SubscriptionStatus;
  billingInterval: SubscriptionBillingInterval;
  billingProvider?: SubscriptionProvider | null;
  channelCode: number;
  startsAt: string;
  trialStartsAt?: string | null;
  trialEndsAt?: string | null;
  plannedPeriodEndsAt?: string | null;
  actualEndsAt?: string | null;
  currentPeriodEndsAt?: string | null;
  cancelAtPeriodEnd?: boolean;
  providerSubscriptionId?: string | null;
  providerCustomerId?: string | null;
  storeProductId?: string | null;
  storeEnvironment?: SubscriptionStoreEnvironment | null;
  createdAt: string;
  updatedAt: string;
}

export interface RelayEntitlement {
  tier: SubscriptionTierId;
  status: SubscriptionStatus;
  canUseRelay: boolean;
  usedHosts: number;
  maxHosts: number;
  remainingHosts: number;
  trialEligible: boolean;
}

const SUBSCRIPTION_EXPIRY_GRACE_HOUR_MS = 60 * 60 * 1000;

export function getSubscriptionExpiryHourEndMs(value: string | null | undefined): number {
  if (!value) {
    return Number.NaN;
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return Number.NaN;
  }
  return Math.floor(timestamp / SUBSCRIPTION_EXPIRY_GRACE_HOUR_MS) *
    SUBSCRIPTION_EXPIRY_GRACE_HOUR_MS +
    SUBSCRIPTION_EXPIRY_GRACE_HOUR_MS -
    1;
}

export function normalizeSubscriptionEndsAtToExpiryHourEnd(
  value: string | null | undefined
): string | null {
  const timestamp = getSubscriptionExpiryHourEndMs(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

export const SUBSCRIPTION_PLANS: SubscriptionPlanDefinition[] = [
  {
    id: "free",
    monthlyPriceUsd: 0,
    relayHosts: 0,
    gridOrder: -1
  },
  {
    id: "lite",
    monthlyPriceUsd: 2.99,
    relayHosts: 1,
    gridOrder: 0
  },
  {
    id: "pro",
    monthlyPriceUsd: 9.99,
    relayHosts: 10,
    gridOrder: 1,
    mostPopular: true,
    trialDays: 7
  },
  {
    id: "plus",
    monthlyPriceUsd: 5.99,
    relayHosts: 3,
    gridOrder: 2
  },
  {
    id: "max",
    monthlyPriceUsd: 19.99,
    relayHosts: 20,
    gridOrder: 3
  }
];

export const ENABLED_SUBSCRIPTION_PAYMENT_PROVIDERS: SubscriptionProvider[] = [
  "apple_iap",
  "google_iap"
];

export const RESERVED_SUBSCRIPTION_PAYMENT_PROVIDERS: SubscriptionProvider[] = [
  "stripe",
  "wechat_pay"
];

export const SUBSCRIPTION_STORE_PRODUCTS: SubscriptionStoreProductDefinition[] = [
  {
    tier: "lite",
    provider: "apple_iap",
    platform: "ios",
    productId: "Lite",
    currentPlanId: "Lite"
  },
  {
    tier: "plus",
    provider: "apple_iap",
    platform: "ios",
    productId: "Plus",
    currentPlanId: "Plus"
  },
  {
    tier: "pro",
    provider: "apple_iap",
    platform: "ios",
    productId: "Pro",
    currentPlanId: "Pro"
  },
  {
    tier: "max",
    provider: "apple_iap",
    platform: "ios",
    productId: "Max",
    currentPlanId: "Max"
  },
  {
    tier: "lite",
    provider: "google_iap",
    platform: "android",
    productId: "relay",
    currentPlanId: "lite"
  },
  {
    tier: "plus",
    provider: "google_iap",
    platform: "android",
    productId: "relay",
    currentPlanId: "plus"
  },
  {
    tier: "pro",
    provider: "google_iap",
    platform: "android",
    productId: "relay",
    currentPlanId: "pro"
  },
  {
    tier: "max",
    provider: "google_iap",
    platform: "android",
    productId: "relay",
    currentPlanId: "max"
  }
];

function normalizeStoreIdentifier(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

export function getSubscriptionPlanCode(planId: SubscriptionTierId): number {
  return SUBSCRIPTION_PLAN_CODE_BY_ID[planId];
}

export function getSubscriptionProviderCode(provider: SubscriptionProvider): number {
  return SUBSCRIPTION_PROVIDER_CODE_BY_ID[provider];
}

export function getSubscriptionStatusCode(status: SubscriptionStatus): number {
  return SUBSCRIPTION_STATUS_CODE_BY_ID[status];
}

export function getSubscriptionPlan(
  planId: SubscriptionPlanId
): SubscriptionPlanDefinition {
  const plan = SUBSCRIPTION_PLANS.find((entry) => entry.id === planId);
  if (!plan) {
    throw new Error(`Unknown subscription plan: ${planId}`);
  }
  return plan;
}

export function getSubscriptionStoreProductId(
  tier: Exclude<SubscriptionPlanId, "free">,
  platform: SubscriptionStorePlatform
): string {
  const record = getSubscriptionStoreProduct(tier, platform);
  return record.productId;
}

export function getSubscriptionStoreCurrentPlanId(
  tier: Exclude<SubscriptionPlanId, "free">,
  platform: SubscriptionStorePlatform
): string {
  const record = getSubscriptionStoreProduct(tier, platform);
  return record.currentPlanId;
}

export function getSubscriptionStoreProduct(
  tier: Exclude<SubscriptionPlanId, "free">,
  platform: SubscriptionStorePlatform
): SubscriptionStoreProductDefinition {
  const record = SUBSCRIPTION_STORE_PRODUCTS.find(
    (entry) => entry.tier === tier && entry.platform === platform
  );
  if (!record) {
    throw new Error(`No store product is defined for ${tier} on ${platform}`);
  }
  return record;
}

export function resolveSubscriptionStoreProduct(input: {
  provider?: Extract<SubscriptionProvider, "apple_iap" | "google_iap"> | null;
  platform?: SubscriptionStorePlatform | null;
  productId?: string | null;
  currentPlanId?: string | null;
}): SubscriptionStoreProductDefinition | null {
  const productId = normalizeStoreIdentifier(input.productId);
  const currentPlanId = normalizeStoreIdentifier(input.currentPlanId);
  const matches = SUBSCRIPTION_STORE_PRODUCTS.filter((entry) => {
    if (input.provider && entry.provider !== input.provider) {
      return false;
    }
    if (input.platform && entry.platform !== input.platform) {
      return false;
    }
    if (productId && entry.productId !== productId) {
      return false;
    }
    if (currentPlanId && entry.currentPlanId !== currentPlanId) {
      return false;
    }
    return productId != null || currentPlanId != null;
  });

  return matches.length === 1 ? matches[0] : null;
}

export function resolveSubscriptionTierFromProductId(
  productId: string
): PaidSubscriptionPlanId | null {
  return resolveSubscriptionStoreProduct({ productId })?.tier ?? null;
}

export function isSubscriptionActive(
  subscription:
    | Pick<
        UserSubscription,
        "status" | "startsAt" | "currentPeriodEndsAt" | "actualEndsAt" | "plannedPeriodEndsAt"
      >
    | null
    | undefined,
  now = Date.now()
): boolean {
  if (!subscription) {
    return false;
  }
  if (subscription.status !== "active" && subscription.status !== "trialing") {
    return false;
  }
  if (subscription.startsAt) {
    const startsAt = new Date(subscription.startsAt).getTime();
    if (!Number.isNaN(startsAt) && startsAt > now) {
      return false;
    }
  }
  const endsAtValue =
    subscription.actualEndsAt ?? subscription.currentPeriodEndsAt ?? subscription.plannedPeriodEndsAt;
  if (!endsAtValue) {
    return true;
  }
  const endsAt = getSubscriptionExpiryHourEndMs(endsAtValue);
  return !Number.isNaN(endsAt) && endsAt > now;
}

export function getRelayHostLimitForTier(planId: SubscriptionTierId): number {
  if (planId === "customize") {
    return CUSTOMIZE_DEFAULT_MAX_HOSTS;
  }
  return getSubscriptionPlan(planId).relayHosts;
}

export function buildRelayEntitlement(input: {
  subscription?: UserSubscription | null;
  usedHosts?: number;
  now?: number;
}): RelayEntitlement {
  const usedHosts = Math.max(0, input.usedHosts ?? 0);
  const activeSubscription = isSubscriptionActive(input.subscription ?? null, input.now);
  if (!input.subscription || !activeSubscription) {
    return {
      tier: "free",
      status: input.subscription?.status ?? "inactive",
      canUseRelay: false,
      usedHosts,
      maxHosts: 0,
      remainingHosts: 0,
      trialEligible: true
    };
  }

  const maxHosts =
    typeof input.subscription.maxHosts === "number" && Number.isFinite(input.subscription.maxHosts)
      ? Math.max(0, input.subscription.maxHosts)
      : getRelayHostLimitForTier(input.subscription.tier);
  return {
    tier: input.subscription.tier,
    status: input.subscription.status,
    canUseRelay: maxHosts > 0,
    usedHosts,
    maxHosts,
    remainingHosts: Math.max(0, maxHosts - usedHosts),
    trialEligible: false
  };
}
