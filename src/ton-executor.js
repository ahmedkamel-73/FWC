// src/ton-executor.js - FWC FIXED - V4 Jetton Transfer
// Sends FWC Jetton from Treasury (12-word mnemonic) - 4 per TX

import { CONFIG } from './config.js';

export const TON_CONFIG = {
  endpoint: 'https://toncenter.com/api/v2/jsonRPC',
  jettonMaster: CONFIG.jetton,
  treasury: CONFIG.treasury,
  maxBatch: 4,
  gasAmount: '0.07',
  forwardTonAmount: '0.02',
};

const USE_HIGHLOAD = false;

async function getJettonWalletAddress(env, ownerAddress) {
  try {
    // Use Toncenter V3 API to get jetton wallet
    const apiKey = env.TONCENTER_API_KEY;
    const url = `https://toncenter.com/api/v3/jetton/wallets?owner_address=${ownerAddress}&jetton_address=${TON_CONFIG.jettonMaster}&limit=1`;
    const res = await fetch(url, { headers: { 'X-API-Key': apiKey } });
    const data = await res.json();
    if (data.jetton_wallets && data.jetton_wallets.length > 0) {
      return data.jetton_wallets[0].address;
    }
    throw new Error('Jetton wallet not found for owner');
  } catch (e) {
    throw new Error('getJettonWallet failed: ' + e.message);
  }
}

export async function executeBatchOnChain(env, batchTx) {
  try {
    if (!env.TON_MNEMONIC_TREASURY) {
      return { ok: false, error: 'TON_MNEMONIC_TREASURY missing', mock: true, batch: batchTx };
    }
    if (!batchTx || !batchTx.messages || batchTx.messages.length === 0) {
      return { ok: false, error: 'Empty batch' };
    }

    if (!USE_HIGHLOAD) {
      const { mnemonicToPrivateKey } = await import('@ton/crypto');
      const { TonClient, WalletContractV4, internal, toNano, Address, beginCell, SendMode } = await import('@ton/ton');

      const client = new TonClient({
        endpoint: TON_CONFIG.endpoint,
        apiKey: env.TONCENTER_API_KEY,
      });

      const words = env.TON_MNEMONIC_TREASURY.trim().split(/\s+/);
      const keyPair = await mnemonicToPrivateKey(words);
      const wallet = WalletContractV4.create({ publicKey: keyPair.publicKey, workchain: 0 });
      const contract = client.open(wallet);

      // Get Treasury jetton wallet address
      const jettonWalletAddrStr = await getJettonWalletAddress(env, wallet.address.toString());
      const jettonWalletAddress = Address.parse(jettonWalletAddrStr);

      const gasTon = toNano(TON_CONFIG.gasAmount);
      const forwardTon = toNano(TON_CONFIG.forwardTonAmount);

      const chunks = [];
      for (let i = 0; i < batchTx.messages.length; i += 4) {
        chunks.push(batchTx.messages.slice(i, i + 4));
      }

      let lastLt = '';

      for (const chunk of chunks) {
        const seqno = await contract.getSeqno();

        const messages = chunk.map(m => {
          // amount can be m.amount or m.nanoAmount - handle both
          let amountNano;
          if (m.nanoAmount) {
            amountNano = BigInt(m.nanoAmount);
          } else if (m.amount) {
            // m.amount is in FWC (e.g. 950), convert to nano (9 decimals)
            const amt = typeof m.amount === 'string' ? parseFloat(m.amount) : m.amount;
            amountNano = BigInt(Math.floor(amt * 1e9));
          } else {
            throw new Error('No amount in message');
          }

          const destAddr = Address.parse(m.wallet || m.address);

          // TEP-74 Jetton transfer body
          const body = beginCell()
            .storeUint(0xf8a7ea5, 32) // op = jetton transfer
            .storeUint(0, 64) // query_id
            .storeCoins(amountNano)
            .storeAddress(destAddr) // destination
            .storeAddress(wallet.address) // response destination (refund)
            .storeUint(0, 1) // custom_payload null
            .storeCoins(forwardTon)
            .storeUint(0, 1) // forward_payload null
            .endCell();

          return internal({
            to: jettonWalletAddress,
            value: gasTon,
            body,
          });
        });

        await contract.sendTransfer({
          seqno,
          secretKey: keyPair.secretKey,
          messages,
          sendMode: SendMode.PAY_GAS_SEPARATELY | SendMode.IGNORE_ERRORS,
        });

        // Small delay to avoid seqno collision
        await new Promise(r => setTimeout(r, 1500));
        lastLt = `chunk_${Date.now()}`;
      }

      return { ok: true, txHash: lastLt, count: batchTx.messages.length, chunks: chunks.length, jettonWallet: jettonWalletAddrStr };
    }

    return { ok: false, error: 'Highload not implemented yet' };
  } catch (err) {
    return { ok: false, error: err.message || String(err), stack: err.stack?.slice(0, 500) };
  }
}

export async function verifyTreasurySetup(env) {
  try {
    if (!env.TON_MNEMONIC_TREASURY) return { ok: false, error: 'TON_MNEMONIC_TREASURY missing' };
    const words = env.TON_MNEMONIC_TREASURY.trim().split(/\s+/);
    if (words.length !== 24 && words.length !== 12) return { ok: false, error: `Mnemonic has ${words.length} words` };
    const jettonWallet = await getJettonWalletAddress(env, CONFIG.treasury);
    return { ok: true, wordCount: words.length, treasury: CONFIG.treasury, jettonWallet };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export async function estimateGasCost(env, count) {
  const perMessageGas = parseFloat(TON_CONFIG.gasAmount);
  const perMessageForward = parseFloat(TON_CONFIG.forwardTonAmount);
  const perMsg = perMessageGas;
  const chunks = Math.ceil(count / 4);
  const total = perMsg * chunks + perMessageForward * count;
  return { count, chunks, perMessage: perMsg, total: total.toFixed(3), totalWithBuffer: (total * 1.2).toFixed(3) };
}
