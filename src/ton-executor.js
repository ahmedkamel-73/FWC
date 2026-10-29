
import { CONFIG } from './config.js';

export const TON_CONFIG = {
  endpoint: 'https://toncenter.com/api/v2/jsonRPC',
  jettonMaster: CONFIG.jetton,
  treasury: CONFIG.treasury,
  maxBatch: 254,
  gasAmount: '0.3',
  forwardTonAmount: '0.01',
};

async function getJettonWalletAddress(env, ownerAddress) {
  const apiKey = env.TONCENTER_API_KEY;
  const url = `https://toncenter.com/api/v3/jetton/wallets?owner_address=${ownerAddress}&jetton_address=${TON_CONFIG.jettonMaster}&limit=1`;
  const res = await fetch(url, { headers: { 'X-API-Key': apiKey } });
  const data = await res.json();
  if (data.jetton_wallets && data.jetton_wallets.length > 0) {
    return data.jetton_wallets[0].address;
  }
  throw new Error('Jetton wallet not found for ' + ownerAddress);
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
    const { TonClient, internal, toNano, Address, beginCell, SendMode, contractAddress, Cell } = await import('@ton/ton');
    const { HighloadWalletV3, HighloadQueryId } = await import('./highload-wallet.js');

    const client = new TonClient({
      endpoint: TON_CONFIG.endpoint,
      apiKey: env.TONCENTER_API_KEY,
    });

    const words = env.TON_MNEMONIC_TREASURY.trim().split(/\s+/);
    const keyPair = await mnemonicToPrivateKey(words);

    const walletContract = new HighloadWalletV3(keyPair.publicKey, 0x10ad, 86400);
    const wallet = client.open(walletContract);

    const jettonWalletAddrStr = await getJettonWalletAddress(env, wallet.address.toString());
    const jettonWalletAddress = Address.parse(jettonWalletAddrStr);

    const gasTon = toNano('0.05');
    const forwardTon = toNano(TON_CONFIG.forwardTonAmount);

    const messages = batchTx.messages.slice(0, 254).map(m => {
      const nanoAmount = BigInt(Math.floor(m.amount * 1e9));
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

    const queryId = HighloadQueryId.fromSeqno(BigInt(Date.now() % 8380416));
    const createdAt = Math.floor(Date.now() / 1000) - 30;

    // Build actions dictionary
    const { Dictionary } = await import('@ton/core');
    let actionsDict = Dictionary.empty(Dictionary.Keys.Uint(8), Dictionary.Values.Cell());
    for (let i = 0; i < messages.length; i++) {
      const actionCell = beginCell()
        .storeUint(SendMode.PAY_GAS_SEPARATELY, 8)
        .storeRef(messages[i])
        .endCell();
      actionsDict.set(i, actionCell);
    }

    await walletContract.sendExternalMessage(wallet, keyPair.secretKey, {
      message: null,
      mode: 0,
      query_id: queryId,
      createdAt: createdAt,
      subwalletId: 0x10ad,
      timeout: 86400,
    });

    // Actually use sendTransfer with our custom logic
    // Fallback to simple loop using sendExternalMessage for batch
    // For Workers compatibility, we send as one external with all actions
    const payloadDict = actionsDict;

    // Rebuild final external
    const payload = beginCell()
      .storeUint(0x10ad, 32)
      .storeUint(createdAt, 32)
      .storeUint(queryId.getQueryId(), 64)
      .storeUint(86400, 22)
      .storeUint(0, 1)
      .storeDict(null)
      .storeDict(payloadDict)
      .endCell();

    const { sign } = await import('@ton/crypto');
    const signature = sign(payload.hash(), keyPair.secretKey);

    const body = beginCell()
      .storeBuffer(signature)
      .storeUint(0x10ad, 32)
      .storeUint(createdAt, 32)
      .storeUint(queryId.getQueryId(), 64)
      .storeUint(86400, 22)
      .storeUint(0, 1)
      .storeDict(null)
      .storeDict(payloadDict)
      .endCell();

    await client.provider(wallet.address).external(body);

    return { ok: true, txHash: `highload_${Date.now()}`, count: messages.length, jettonWallet: jettonWalletAddrStr, address: wallet.address.toString() };
  } catch (err) {
    return { ok: false, error: err.message || String(err), stack: err.stack?.slice(0,2000) };
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
