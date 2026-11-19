import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  Check,
  Copy,
  CreditCard,
  ExternalLink,
  RefreshCw,
} from 'lucide-react';
import { apiRequest, formatDateTime, formatIdr, paymentStatusLabel } from '../lib/api';
import {
  CreditLedgerEntry,
  CreditPackage,
  MidtransClientInfo,
  PaymentTransaction,
  User,
} from '../types';

declare global {
  interface Window {
    snap?: {
      pay: (
        snapToken: string,
        callbacks?: {
          onSuccess?: (result: unknown) => void;
          onPending?: (result: unknown) => void;
          onError?: (result: unknown) => void;
          onClose?: () => void;
        }
      ) => void;
    };
  }
}

interface BillingViewProps {
  user: User;
  onCreditsUpdated: (credits: number) => void;
  onNotify: (kind: 'info' | 'success' | 'error', message: string) => void;
}

function loadMidtransSnapScript(snapJsUrl: string, clientKey: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.snap) {
      resolve();
      return;
    }
    const existing = document.getElementById('midtrans-snap-script') as HTMLScriptElement | null;
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error('Gagal memuat Midtrans Snap.js')), {
        once: true,
      });
      return;
    }

    const script = document.createElement('script');
    script.id = 'midtrans-snap-script';
    script.src = snapJsUrl;
    script.setAttribute('data-client-key', clientKey);
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Gagal memuat skrip pembayaran Midtrans Snap.js'));
    document.head.appendChild(script);
  });
}

export function BillingView({ user, onCreditsUpdated, onNotify }: BillingViewProps) {
  const [packages, setPackages] = useState<CreditPackage[]>([]);
  const [midtrans, setMidtrans] = useState<MidtransClientInfo | null>(null);
  const [transactions, setTransactions] = useState<PaymentTransaction[]>([]);
  const [ledger, setLedger] = useState<CreditLedgerEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'transactions' | 'ledger'>('transactions');
  const [creatingPkgId, setCreatingPkgId] = useState<string | null>(null);
  const [syncingOrderId, setSyncingOrderId] = useState<string | null>(null);
  const [copiedWebhook, setCopiedWebhook] = useState(false);

  const loadBillingData = useCallback(async () => {
    try {
      const [pkgRes, txRes, ldgRes] = await Promise.all([
        apiRequest<{ packages: CreditPackage[]; midtrans: MidtransClientInfo }>('/api/billing/packages'),
        apiRequest<{ transactions: PaymentTransaction[] }>('/api/billing/transactions'),
        apiRequest<{ ledger: CreditLedgerEntry[] }>('/api/billing/ledger'),
      ]);
      setPackages(pkgRes.packages);
      setMidtrans(pkgRes.midtrans);
      setTransactions(txRes.transactions);
      setLedger(ldgRes.ledger);
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'Gagal memuat data saldo.');
    } finally {
      setLoading(false);
    }
  }, [onNotify]);

  useEffect(() => {
    void loadBillingData();
  }, [loadBillingData, user.credits]);

  const syncOrderStatus = useCallback(
    async (orderId: string, silent = false) => {
      setSyncingOrderId(orderId);
      try {
        const res = await apiRequest<{
          transaction: PaymentTransaction;
          credits: number;
          creditedNow: boolean;
        }>(`/api/payments/${encodeURIComponent(orderId)}/sync`, { method: 'POST' });

        onCreditsUpdated(res.credits);
        await loadBillingData();

        if (res.creditedNow) {
          onNotify(
            'success',
            `Pembayaran ${orderId} terkonfirmasi! Saldo +${res.transaction.credits} kredit telah masuk.`
          );
        } else if (!silent) {
          const st = paymentStatusLabel(res.transaction.status);
          onNotify('info', `Status order ${orderId}: ${st.label}`);
        }
      } catch (err) {
        if (!silent) {
          onNotify('error', err instanceof Error ? err.message : 'Gagal mengecek status pembayaran.');
        }
      } finally {
        setSyncingOrderId(null);
      }
    },
    [loadBillingData, onCreditsUpdated, onNotify]
  );

  // Auto-sync if redirected back from Midtrans with ?order_id=...
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const orderId = params.get('order_id');
    if (orderId) {
      void syncOrderStatus(orderId, false);
      const url = new URL(window.location.href);
      url.searchParams.delete('order_id');
      window.history.replaceState({}, '', url.toString());
    }
  }, [syncOrderStatus]);

  async function openMidtransSnap(snapToken: string, redirectUrl: string | null, orderId: string) {
    if (!midtrans?.configured) return;
    try {
      await loadMidtransSnapScript(midtrans.snapJsUrl, midtrans.clientKey);
      if (window.snap) {
        window.snap.pay(snapToken, {
          onSuccess: () => {
            void syncOrderStatus(orderId, false);
          },
          onPending: () => {
            onNotify('info', 'Instruksi pembayaran dibuat. Saldo masuk otomatis setelah dibayar.');
            void loadBillingData();
          },
          onError: () => {
            onNotify('error', 'Pembayaran gagal diproses oleh Midtrans.');
            void loadBillingData();
          },
          onClose: () => {
            void syncOrderStatus(orderId, true);
          },
        });
        return;
      }
    } catch {
      // Fallback below
    }
    if (redirectUrl) {
      window.location.href = redirectUrl;
    }
  }

  async function handleCheckout(pkg: CreditPackage) {
    setCreatingPkgId(pkg.id);
    try {
      const res = await apiRequest<{
        orderId: string;
        snapToken: string;
        redirectUrl: string;
        transaction: PaymentTransaction;
      }>('/api/payments/create', {
        method: 'POST',
        body: JSON.stringify({ packageId: pkg.id }),
      });

      setTransactions((prev) => [res.transaction, ...prev]);
      await openMidtransSnap(res.snapToken, res.redirectUrl, res.orderId);
    } catch (err) {
      onNotify('error', err instanceof Error ? err.message : 'Gagal memulai pembayaran Midtrans.');
    } finally {
      setCreatingPkgId(null);
    }
  }

  async function copyWebhook() {
    if (!midtrans?.webhookUrl) return;
    try {
      await navigator.clipboard.writeText(midtrans.webhookUrl);
      setCopiedWebhook(true);
      setTimeout(() => setCopiedWebhook(false), 2000);
    } catch {
      onNotify('error', 'Gagal menyalin URL webhook.');
    }
  }

  function ledgerTypeLabel(type: CreditLedgerEntry['type']): string {
    switch (type) {
      case 'signup_bonus':
        return 'Bonus Registrasi';
      case 'topup':
        return 'Top-Up Midtrans';
      case 'generation_debit':
        return 'Render Video';
      case 'generation_refund':
        return 'Refund Otomatis';
      case 'admin_adjustment':
        return 'Penyesuaian Admin';
    }
  }

  return (
    <div className="space-y-8">
      {/* Header summary */}
      <div className="flex flex-wrap items-end justify-between gap-4 pb-6 border-b border-[#1E2636]">
        <div className="space-y-1">
          <h1 className="font-display text-2xl font-bold text-white">Top-Up & Saldo Kredit</h1>
          <p className="text-sm text-slate-400">
            Tarif per detik: <span className="font-mono text-slate-200">480p = 1 kredit</span> ·{' '}
            <span className="font-mono text-slate-200">720p = 2 kredit</span> ·{' '}
            <span className="font-mono text-slate-200">1080p = 3 kredit</span>. Saldo masuk otomatis setelah pembayaran Midtrans selesai.
          </p>
        </div>

        <div className="text-right">
          <p className="text-xs text-slate-400">Saldo Tersedia</p>
          <p className="font-mono text-3xl font-bold text-white tabular-nums mt-0.5">
            {user.credits.toLocaleString('id-ID')}{' '}
            <span className="text-sm font-normal text-slate-400">kredit</span>
          </p>
        </div>
      </div>

      {/* Midtrans setup alert if env keys not configured */}
      {midtrans && !midtrans.configured && (
        <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/25 space-y-2.5">
          <div className="flex items-start gap-2.5">
            <AlertCircle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            <div className="space-y-1 text-sm">
              <p className="font-medium text-amber-200">
                Midtrans belum terkonfigurasi di environment server
              </p>
              <p className="text-xs text-amber-200/80 leading-relaxed">
                Tambahkan <code className="font-mono text-amber-100">MIDTRANS_SERVER_KEY</code> dan{' '}
                <code className="font-mono text-amber-100">MIDTRANS_CLIENT_KEY</code> di panel Secrets / file{' '}
                <code className="font-mono text-amber-100">.env</code> (serta{' '}
                <code className="font-mono text-amber-100">MIDTRANS_IS_PRODUCTION=false</code> untuk Sandbox), lalu atur Payment Notification URL di Dashboard Midtrans ke endpoint berikut:
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 pl-6">
            <code className="flex-1 px-3 py-1.5 bg-[#0B0E14] border border-[#232C3D] rounded-md text-xs font-mono text-slate-200 truncate">
              {midtrans.webhookUrl}
            </code>
            <button
              type="button"
              onClick={copyWebhook}
              className="px-3 py-1.5 text-xs font-medium text-slate-200 bg-[#181F2C] hover:bg-[#222B3C] border border-[#2A3548] rounded-md inline-flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
            >
              {copiedWebhook ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              <span>{copiedWebhook ? 'Disalin' : 'Salin Webhook'}</span>
            </button>
          </div>
        </div>
      )}

      {/* Tiered Credit Packages */}
      <section className="space-y-4">
        <div className="flex items-baseline justify-between gap-4">
          <h2 className="font-display text-base font-semibold text-white">Pilih Paket Kredit</h2>
          {midtrans?.configured && (
            <span className="text-xs font-mono text-slate-400">
              Midtrans Snap · {midtrans.isProduction ? 'Production' : 'Sandbox'}
            </span>
          )}
        </div>

        <div className="grid sm:grid-cols-2 xl:grid-cols-4 gap-4">
          {packages.map((pkg) => (
            <div
              key={pkg.id}
              className={`bg-[#121721] rounded-xl p-5 flex flex-col justify-between gap-6 border ${
                pkg.featured ? 'border-cyan-500/50' : 'border-[#232C3D]'
              }`}
            >
              <div className="space-y-3">
                <div>
                  <div className="flex items-baseline justify-between gap-2">
                    <h3 className="font-display text-base font-semibold text-white">{pkg.name}</h3>
                    {pkg.savingsPercent > 0 && (
                      <span className="text-xs font-mono text-emerald-400 tabular-nums">
                        Hemat {pkg.savingsPercent}%
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-slate-400 mt-1">{pkg.audience}</p>
                </div>

                <div className="pt-2 border-t border-[#1E2636] space-y-1">
                  <p className="font-mono text-2xl font-bold text-white tabular-nums">
                    {formatIdr(pkg.priceIdr)}
                  </p>
                  <p className="text-xs font-mono tabular-nums text-slate-400">
                    {pkg.credits.toLocaleString('id-ID')} kredit · {formatIdr(pkg.pricePerCreditIdr)}/kredit
                  </p>
                  <p className="text-xs text-slate-500 font-mono tabular-nums">
                    {pkg.credits}d (480p) · {Math.floor(pkg.credits / 2)}d (720p) · {Math.floor(pkg.credits / 3)}d (1080p)
                  </p>
                </div>
              </div>

              <button
                type="button"
                disabled={creatingPkgId !== null}
                onClick={() => handleCheckout(pkg)}
                className={`w-full h-10 px-4 text-sm font-semibold rounded-lg inline-flex items-center justify-center gap-2 transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50 ${
                  pkg.featured
                    ? 'bg-cyan-500 hover:bg-cyan-400 text-[#071117]'
                    : 'bg-[#181F2C] hover:bg-[#222B3C] text-white border border-[#2A3548]'
                }`}
              >
                <CreditCard className="w-4 h-4" />
                <span>{creatingPkgId === pkg.id ? 'Membuka Snap...' : 'Bayar via Midtrans'}</span>
              </button>
            </div>
          ))}
        </div>
      </section>

      {/* Transactions & Credit Ledger Tables */}
      <section className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-1 p-1 bg-[#121721] border border-[#232C3D] rounded-lg">
            <button
              type="button"
              onClick={() => setActiveTab('transactions')}
              className={`px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                activeTab === 'transactions'
                  ? 'bg-[#181F2C] text-white'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Riwayat Pembayaran Midtrans ({transactions.length})
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('ledger')}
              className={`px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                activeTab === 'ledger'
                  ? 'bg-[#181F2C] text-white'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Buku Besar Mutasi Kredit ({ledger.length})
            </button>
          </div>

          <button
            type="button"
            onClick={() => void loadBillingData()}
            className="px-3 py-1.5 text-xs text-slate-300 hover:text-white bg-[#121721] border border-[#232C3D] rounded-lg inline-flex items-center gap-1.5 cursor-pointer"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Muat Ulang</span>
          </button>
        </div>

        <div className="bg-[#121721] border border-[#232C3D] rounded-xl overflow-hidden">
          {loading ? (
            <div className="p-6 space-y-3">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-10 bg-[#181F2C] rounded animate-pulse" />
              ))}
            </div>
          ) : activeTab === 'transactions' ? (
            transactions.length === 0 ? (
              <div className="py-12 px-6 text-center text-sm text-slate-400">
                Belum ada transaksi pembayaran Midtrans. Pilih salah satu paket kredit di atas untuk top-up otomatis.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-[#1E2636] text-xs text-slate-400 font-medium">
                      <th className="py-3 px-4">Order ID</th>
                      <th className="py-3 px-4">Paket</th>
                      <th className="py-3 px-4 text-right">Kredit</th>
                      <th className="py-3 px-4 text-right">Nominal</th>
                      <th className="py-3 px-4">Status</th>
                      <th className="py-3 px-4">Waktu</th>
                      <th className="py-3 px-4 text-right">Aksi</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#1E2636] text-sm">
                    {transactions.map((tx) => {
                      const st = paymentStatusLabel(tx.status);
                      return (
                        <tr key={tx.order_id} className="hover:bg-[#181F2C]/40 transition-colors">
                          <td className="py-3 px-4 font-mono text-xs text-slate-200 whitespace-nowrap">
                            {tx.order_id}
                          </td>
                          <td className="py-3 px-4 text-slate-200 whitespace-nowrap">
                            {tx.package_name}
                            {tx.payment_type && (
                              <span className="text-xs text-slate-500 ml-2">· {tx.payment_type}</span>
                            )}
                          </td>
                          <td className="py-3 px-4 text-right font-mono tabular-nums text-cyan-400 whitespace-nowrap">
                            +{tx.credits}
                          </td>
                          <td className="py-3 px-4 text-right font-mono tabular-nums text-white whitespace-nowrap">
                            {formatIdr(tx.gross_amount)}
                          </td>
                          <td className={`py-3 px-4 text-xs font-medium whitespace-nowrap ${st.colorClass}`}>
                            {st.label}
                          </td>
                          <td className="py-3 px-4 text-xs font-mono tabular-nums text-slate-400 whitespace-nowrap">
                            {formatDateTime(tx.settled_at || tx.created_at)}
                          </td>
                          <td className="py-3 px-4 text-right whitespace-nowrap">
                            {tx.status === 'pending' ? (
                              <div className="inline-flex items-center gap-2">
                                {tx.snap_token && (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      void openMidtransSnap(tx.snap_token!, tx.snap_redirect_url, tx.order_id)
                                    }
                                    className="text-xs font-medium text-cyan-400 hover:text-cyan-300 inline-flex items-center gap-1 cursor-pointer"
                                  >
                                    <span>Bayar</span>
                                    <ExternalLink className="w-3 h-3" />
                                  </button>
                                )}
                                <button
                                  type="button"
                                  disabled={syncingOrderId === tx.order_id}
                                  onClick={() => void syncOrderStatus(tx.order_id, false)}
                                  className="text-xs text-slate-300 hover:text-white cursor-pointer"
                                >
                                  {syncingOrderId === tx.order_id ? 'Mengecek...' : 'Cek Status'}
                                </button>
                              </div>
                            ) : (
                              <span className="text-xs text-slate-600">—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )
          ) : ledger.length === 0 ? (
            <div className="py-12 px-6 text-center text-sm text-slate-400">
              Belum ada catatan mutasi kredit.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-[#1E2636] text-xs text-slate-400 font-medium">
                    <th className="py-3 px-4">Waktu</th>
                    <th className="py-3 px-4">Tipe</th>
                    <th className="py-3 px-4">Keterangan</th>
                    <th className="py-3 px-4 text-right">Mutasi</th>
                    <th className="py-3 px-4 text-right">Saldo Akhir</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#1E2636] text-sm">
                  {ledger.map((row) => (
                    <tr key={row.id} className="hover:bg-[#181F2C]/40 transition-colors">
                      <td className="py-3 px-4 font-mono text-xs tabular-nums text-slate-400 whitespace-nowrap">
                        {formatDateTime(row.created_at)}
                      </td>
                      <td className="py-3 px-4 text-xs text-slate-300 whitespace-nowrap">
                        {ledgerTypeLabel(row.type)}
                      </td>
                      <td className="py-3 px-4 text-slate-200 max-w-md truncate">
                        {row.description}
                      </td>
                      <td
                        className={`py-3 px-4 text-right font-mono tabular-nums font-semibold whitespace-nowrap ${
                          row.amount >= 0 ? 'text-emerald-400' : 'text-rose-400'
                        }`}
                      >
                        {row.amount > 0 ? `+${row.amount}` : row.amount}
                      </td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-200 whitespace-nowrap">
                        {row.balance_after}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
