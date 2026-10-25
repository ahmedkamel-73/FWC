// src/highload-wallet.js - Highload Wallet V2 Wrapper
// Enables up to 255 transfers per TX

import { Address, beginCell, Cell, contractAddress, Contract, ContractProvider, Sender, SendMode, toNano } from '@ton/core';

export class HighloadWalletV2 {
  constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

  static createFromConfig(publicKey: Buffer, workchain = 0, opts = {}) {
    const code = HighloadWalletV2.code;
    const data = beginCell()
      .storeUint(1, 1)                    // V2 flag
      .storeUint(0, 1)                    // subwallet_id flag
      .storeUint(opts.subwalletId ?? 0, 15)
      .storeBuffer(publicKey)
      .storeUint(0, 64)                   // last_cleaned
      .storeDict(null)                    // old_queries dict
      .endCell();
    const address = contractAddress(workchain, { code, data });
    return new HighloadWalletV2(address, { code, data });
  }

  async sendDeploy(provider: ContractProvider, via: Sender, value: bigint = toNano('0.1')) {
    await provider.internal(via, {
      value,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      body: beginCell().endCell(),
    });
  }

  async getPublicKey(provider: ContractProvider) {
    const result = await provider.get('get_public_key', []);
    return result.stack.readBigNumber();
  }

  async getLastCleaned(provider: ContractProvider) {
    const result = await provider.get('get_last_cleaned', []);
    return result.stack.readNumber();
  }

  // Static wallet code (Highload V2 code hash) - يحتاج تحميل الكود الفعلي
  static code = null; 
}