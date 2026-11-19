import crypto from 'crypto';

export interface CreditPackage {
  id: string;
  name: string;
  audience: string;
  credits: number;
  priceIdr: number;
  pricePerCreditIdr: number;
  savingsPercent: number;
  featured?: boolean;
}

export const CREDIT_PACKAGES: CreditPackage[] = [
  {
    id: 'starter_25',
    name: 'Starter',
    audience: 'Untuk uji coba cepat & proyek singkat',
    credits: 25,
    priceIdr: 25000,
    pricePerCreditIdr: 1000,
    savingsPercent: 0,
  },
  {
    id: 'creator_100',
    name: 'Creator',
    audience: 'Untuk kreator konten rutin',
    credits: 100,
    priceIdr: 95000,
    pricePerCreditIdr: 950,
    savingsPercent: 5,
    featured: true,
  },
  {
    id: 'studio_300',
    name: 'Studio',
    audience: 'Untuk produksi harian & kampanye',
    credits: 300,
    priceIdr: 270000,
    pricePerCreditIdr: 900,
    savingsPercent: 10,
  },
  {
    id: 'agency_1000',
    name: 'Agency',
    audience: 'Untuk tim skala besar & volume tinggi',
    credits: 1000,
    priceIdr: 850000,
    pricePerCreditIdr: 850,
    savingsPercent: 15,
  },
];

export function getCreditPackageById(id: string): CreditPackage | undefined {
  return CREDIT_PACKAGES.find((p) => p.id === id);
}

export interface MidtransRuntimeConfig {
  serverKey: string;
  clientKey: string;
  isProduction: boolean;
  configured: boolean;
  snapApiUrl: string;
  coreApiUrl: string;
  snapJsUrl: string;
}

export function getMidtransConfig(): MidtransRuntimeConfig {
  const serverKey = (process.env.MIDTRANS_SERVER_KEY || '').trim();
  const clientKey = (process.env.MIDTRANS_CLIENT_KEY || '').trim();
  const isProduction = process.env.MIDTRANS_IS_PRODUCTION === 'true';

  return {
    serverKey,
    clientKey,
    isProduction,
    configured: Boolean(serverKey && clientKey),
    snapApiUrl: isProduction
      ? 'https://app.midtrans.com/snap/v1/transactions'
      : 'https://app.sandbox.midtrans.com/snap/v1/transactions',
    coreApiUrl: isProduction
      ? 'https://api.midtrans.com/v2'
      : 'https://api.sandbox.midtrans.com/v2',
    snapJsUrl: isProduction
      ? 'https://app.midtrans.com/snap/snap.js'
      : 'https://app.sandbox.midtrans.com/snap/snap.js',
  };
}

function getBasicAuthHeader(serverKey: string): string {
  return `Basic ${Buffer.from(`${serverKey}:`).toString('base64')}`;
}

export async function createMidtransSnapTransaction(params: {
  orderId: string;
  grossAmount: number;
  pkg: CreditPackage;
  customer: { name: string; email: string };
  appUrl: string;
}): Promise<{ token: string; redirect_url: string }> {
  const cfg = getMidtransConfig();
  if (!cfg.configured) {
    throw new Error('MIDTRANS_NOT_CONFIGURED');
  }

  const webhookUrl = `${params.appUrl.replace(/\/$/, '')}/api/payments/midtrans-webhook`;

  const body = {
    transaction_details: {
      order_id: params.orderId,
      gross_amount: params.grossAmount,
    },
    item_details: [
      {
        id: params.pkg.id,
        price: params.grossAmount,
        quantity: 1,
        name: `Kinetik ${params.pkg.name} (${params.pkg.credits} Kredit)`,
      },
    ],
    customer_details: {
      first_name: params.customer.name.slice(0, 60),
      email: params.customer.email,
    },
    callbacks: {
      finish: `${params.appUrl.replace(/\/$/, '')}/?tab=billing&order_id=${encodeURIComponent(params.orderId)}`,
    },
  };

  const response = await fetch(cfg.snapApiUrl, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: getBasicAuthHeader(cfg.serverKey),
      'X-Override-Notification': webhookUrl,
    },
    body: JSON.stringify(body),
  });

  const data = (await response.json()) as {
    token?: string;
    redirect_url?: string;
    error_messages?: string[];
  };

  if (!response.ok || !data.token || !data.redirect_url) {
    const errMsg = data.error_messages?.join('; ') || `Midtrans Snap HTTP ${response.status}`;
    throw new Error(errMsg);
  }

  return {
    token: data.token,
    redirect_url: data.redirect_url,
  };
}

export interface MidtransStatusPayload {
  order_id: string;
  status_code: string;
  gross_amount: string;
  transaction_status: string;
  fraud_status?: string;
  payment_type?: string;
  transaction_id?: string;
  signature_key?: string;
}

export function verifyMidtransSignature(payload: MidtransStatusPayload): boolean {
  const cfg = getMidtransConfig();
  if (!cfg.serverKey || !payload.signature_key) return false;
  if (!payload.order_id || !payload.status_code || !payload.gross_amount) return false;

  const raw = `${payload.order_id}${payload.status_code}${payload.gross_amount}${cfg.serverKey}`;
  const expected = crypto.createHash('sha512').update(raw).digest('hex');

  const expectedBuf = Buffer.from(expected, 'utf8');
  const incomingBuf = Buffer.from(payload.signature_key.toLowerCase(), 'utf8');
  if (expectedBuf.length !== incomingBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, incomingBuf);
}

export function mapMidtransStatus(
  transactionStatus: string,
  fraudStatus?: string
): 'pending' | 'settlement' | 'expire' | 'cancel' | 'deny' | 'failure' {
  switch (transactionStatus) {
    case 'capture':
      if (fraudStatus === 'challenge') return 'pending';
      if (fraudStatus === 'deny') return 'deny';
      return 'settlement';
    case 'settlement':
      return 'settlement';
    case 'pending':
      return 'pending';
    case 'deny':
      return 'deny';
    case 'cancel':
      return 'cancel';
    case 'expire':
      return 'expire';
    default:
      return 'failure';
  }
}

export async function fetchMidtransOrderStatus(orderId: string): Promise<MidtransStatusPayload> {
  const cfg = getMidtransConfig();
  if (!cfg.configured) {
    throw new Error('MIDTRANS_NOT_CONFIGURED');
  }

  const res = await fetch(`${cfg.coreApiUrl}/${encodeURIComponent(orderId)}/status`, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: getBasicAuthHeader(cfg.serverKey),
    },
  });

  const data = (await res.json()) as MidtransStatusPayload & { status_message?: string };
  if (!res.ok || !data.transaction_status) {
    throw new Error(data.status_message || `Midtrans Status HTTP ${res.status}`);
  }
  return data;
}
