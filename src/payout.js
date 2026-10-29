// src/payout.js - FWC 4.0.0 PRODUCTION
// Batch payout system - 255 transfers per TX (Highload V2)

import { CONFIG } from './config.js';

const BATCH_MAX = 255;
const JETTON_DECIMALS = 9;

export function estimateBatchSaving(count) {
  const singleCost = 0.07 * count;
  const batchCost = 0.3 + (0.02 * count);
  return {
    count,
    singleCost: singleCost.toFixed(2),
    batchCost: batchCost.toFixed(2),
    saved: (singleCost - batchCost).toFixed(2),
    savedPercent: (((singleCost - batchCost) / singleCost) * 100).toFixed(1),
  };
}

export async function getPendingWithdrawalsBatch(db, limit = BATCH_MAX) {
  const res = await db.prepare(`
    SELECT id, telegram_id, amount, net_amount, wallet, created_at 
    FROM withdrawals 
    WHERE status = 'approved' AND wallet IS NOT NULL
    ORDER BY created_at ASC 
    LIMIT ?
  `).bind(limit).all();
  return res.results || [];
}

export async function createBatchPayoutTransaction(db, withdrawals) {
  if (!withdrawals || withdrawals.length === 0) return null;

  const messages = withdrawals.map((wd, idx) => {
    const netAmount = wd.net_amount || wd.amount;
    const nanoAmount = BigInt(Math.floor(netAmount * 10 ** JETTON_DECIMALS));
    return {
      id: wd.id,
      telegram_id: wd.telegram_id,
      wallet: wd.wallet,
      amount: netAmount,
      nanoAmount: nanoAmount.toString(),
      queryId: Date.now() + idx,
    };
  });

  return {
    type: 'highload_batch',
    treasury: CONFIG.treasury,
    jettonMaster: CONFIG.jetton,
    count: messages.length,
    totalAmount: messages.reduce((s, m) => s + m.amount, 0),
    messages,
    estimatedGas: estimateBatchSaving(messages.length),
    createdAt: Date.now(),
  };
}

export async function markBatchAsSent(db, batchTx, txHash) {
  const ids = batchTx.messages.map(m => m.id);
  if (ids.length === 0) return;

  const placeholders = ids.map(() => '?').join(',');
  await db.prepare(`UPDATE withdrawals SET status = 'processing', tx_hash = ?, updated_at = unixepoch() WHERE id IN (${placeholders})`)
    .bind(txHash, ...ids).run();

  await db.prepare(`INSERT INTO payout_batches(tx_hash, count, total_amount, status, created_at) 
    VALUES (?, ?, ?, 'processing', unixepoch())`)
    .bind(txHash, batchTx.count, batchTx.totalAmount).run();

  return { updated: ids.length, txHash };
}

export async function confirmBatch(db, txHash) {
  await db.prepare(`UPDATE withdrawals SET status = 'approved', updated_at = unixepoch() WHERE tx_hash = ?`)
    .bind(txHash).run();
  await db.prepare(`UPDATE payout_batches SET status = 'approved' WHERE tx_hash = ?`)
    .bind(txHash).run();
}

export async function getPayoutStats(db) {
  const pending = await db.prepare(`SELECT COUNT(*) as c, COALESCE(SUM(net_amount),0) as total FROM withdrawals WHERE status='approved'`).first();
  const processing = await db.prepare(`SELECT COUNT(*) as c FROM withdrawals WHERE status='processing'`).first();
  const batches = await db.prepare(`SELECT COUNT(*) as c FROM payout_batches`).first();
  const pendingCount = pending?.c || 0;

  return {
    pendingCount,
    pendingTotal: pending?.total || 0,
    processingCount: processing?.c || 0,
    totalBatches: batches?.c || 0,
    batchesNeeded: Math.ceil(pendingCount / BATCH_MAX),
    gasSaving: pendingCount > 0 ? estimateBatchSaving(Math.min(pendingCount, BATCH_MAX)) : null,
    maxPerBatch: BATCH_MAX,
  };
}
