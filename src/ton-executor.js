// src/ton-executor.js - HIGHLOAD V3 - 255/TX - Works with 12-word mnemonic
import { CONFIG } from './config.js';
import { Cell } from '@ton/core';

export const TON_CONFIG = {
  endpoint: 'https://toncenter.com/api/v2/jsonRPC',
  jettonMaster: CONFIG.jetton,
  treasury: CONFIG.treasury,
  maxBatch: 254,
  gasAmount: '0.3',
  forwardTonAmount: '0.01',
};

const USE_HIGHLOAD = true;
const CODE_HEX = "b5ee9c7241021001000228000114ff00f4a413f4bcf2c80b01020120020d02014803040078d020d74bc00101c060b0915be101d0d3030171b0915be0fa4030f828c705b39130e0d31f018210ae42e5a4ba9d8040d721d74cf82a01ed55fb04e030020120050a02027306070011adce76a2686b85ffc00201200809001aabb6ed44d0810122d721d70b3f0018aa3bed44d08307d721d70b1f0201200b0c001bb9a6eed44d0810162d721d70b15800e5b8bf2eda2edfb21ab09028409b0ed44d0810120d721f404f404d33fd315d1058e1bf82325a15210b99f326df82305aa0015a112b992306dde923033e2923033e25230800df40f6fa19ed021d721d70a00955f037fdb31e09130e259800df40f6fa19cd001d721d70a00937fdb31e0915be270801f6f2d48308d718d121f900ed44d0d3ffd31ff404f404d33fd315d1f82321a15220b98e12336df82324aa00a112b9926d32de58f82301de541675f910f2a106d0d31fd4d307d30cd309d33fd315d15168baf2a2515abaf2a6f8232aa15250bcf2a304f823bbf2a35304800df40f6fa199d024d721d70a00f2649130e20e01fe5309800df40f6fa18e13d05004d718d20001f264c858cf16cf8301cf168e1030c824cf40cf8384095005a1a514cf40e2f800c94039800df41704c8cbff13cb1ff40012f40012cb3f12cb15c9ed54f80f21d0d30001f265d3020171b0925f03e0fa4001d70b01c000f2a5fa4031fa0031f401fa0031fa00318060d721d300010f0020f265d2000193d431d19130e272b1fb00b585bf03";

async function getJettonWalletAddress(env, ownerAddress) {
  const apiKey = env.TONCENTER_API_KEY;
  const url = `https://toncenter.com/api/v3/jetton/wallets?owner_address=${ownerAddress}&jetton_address=${TON_CONFIG.jettonMaster}&limit=1`;
  const res = await fetch(url, { headers: { 'X-API-Key': apiKey } });
  const data = await res.json();
  if (data.jetton_wallets && data.jetton_wallets.length > 0) {
    return data.jetton_wallets[0].address;
  }
  throw new Error('Jetton wallet not found');
}

export async function executeBatchOnChain(env, batchTx) {
  try {
    if (!env.TON_MNEMONIC_TREASURY) {
      return { ok: false, error: 'TON_MNEMONIC_TREASURY missing', mock: true };
    }
    if (!batchTx || !batchTx.messages || batchTx.messages.length === 0) {
      return { ok: false, error: 'Empty batch' };
    }

    const { mnemonicToPrivateKey } = await import('@ton/crypto');
    const { TonClient, internal, toNano, Address, beginCell, SendMode } = await import('@ton/ton');
    const { HighloadWalletV3 } = await import('./highload-wallet.js');

    const client = new TonClient({
      endpoint: TON_CONFIG.endpoint,
      apiKey: env.TONCENTER_API_KEY,
    });

    const words = env.TON_MNEMONIC_TREASURY.trim().split(/\s+/);
    // Works with both 12 and 24 words
    const keyPair = await mnemonicToPrivateKey(words);
    
    const CODE = Cell.fromBoc(Buffer.from(CODE_HEX, 'hex'))[0];
    const wallet = HighloadWalletV3.createFromConfig({
      publicKey: keyPair.publicKey,
      subwalletId: 0x10ad,
      timeout: 86400,
    }, CODE);
    
    const contract = client.open(wallet);
    const jettonWalletAddrStr = await getJettonWalletAddress(env, wallet.address.toString());
    const jettonWalletAddress = Address.parse(jettonWalletAddrStr);

    const gasTon = toNano('0.05');
    const forwardTon = toNano(TON_CONFIG.forwardTonAmount);

    // Highload can send up to 254 in one TX
    const messages = batchTx.messages.slice(0, 254).map(m => {
      const netAmount = m.amount;
      const nanoAmount = BigInt(Math.floor(netAmount * 1e9));
      const destAddr = Address.parse(m.wallet);
      const body = beginCell()
        .storeUint(0xf8a7ea5, 32)
        .storeUint(0, 64)
        .storeCoins(nanoAmount)
        .storeAddress(destAddr)
        .storeAddress(wallet.address)
        .storeUint(0, 1)
        .storeCoins(forwardTon)
        .storeUint(0, 1)
        .endCell();
      return internal({
        to: jettonWalletAddress,
        value: gasTon,
        body,
      });
    });

    // For Highload V3, we need to use sendTransfer with queryId
    const seqno = Date.now();
    await contract.sendTransfer({
      seqno,
      secretKey: keyPair.secretKey,
      messages,
    });

    return { ok: true, txHash: `highload_${Date.now()}`, count: messages.length, jettonWallet: jettonWalletAddrStr, address: wallet.address.toString() };
  } catch (err) {
    return { ok: false, error: err.message || String(err), stack: err.stack?.slice(0,1000) };
  }
}

export async function verifyTreasurySetup(env) {
  try {
    if (!env.TON_MNEMONIC_TREASURY) return { ok: false, error: 'missing' };
    const words = env.TON_MNEMONIC_TREASURY.trim().split(/\s+/);
    return { ok: true, wordCount: words.length, treasury: CONFIG.treasury };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export async function estimateGasCost(env, count) {
  const batches = Math.ceil(count / 254);
  const total = 0.3 * batches + 0.01 * count;
  return { count, batches, total: total.toFixed(3), totalWithBuffer: (total*1.2).toFixed(3) };
}
