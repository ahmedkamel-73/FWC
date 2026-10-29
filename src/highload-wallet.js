
import { Address, beginCell, Cell, contractAddress, Dictionary, SendMode } from '@ton/core';

const CODE_HEX = "b5ee9c7241021001000228000114ff00f4a413f4bcf2c80b01020120020d02014803040078d020d74bc00101c060b0915be101d0d3030171b0915be0fa4030f828c705b39130e0d31f018210ae42e5a4ba9d8040d721d74cf82a01ed55fb04e030020120050a02027306070011adce76a2686b85ffc00201200809001aabb6ed44d0810122d721d70b3f0018aa3bed44d08307d721d70b15800e5b8bf2eda2edfb21ab09028409b0ed44d0810120d721d70b1f0201200b0c001bb9a6eed44d0810162d721d70b15800e5b8bf2eda2edfb21ab09028409b0ed44d0810120d721f404f404d33fd315d1058e1bf82325a15210b99f326df82305aa0015a112b992306dde923033e2923033e25230800df40f6fa19ed021d721d70a00955f037fdb31e09130e259800df40f6fa19cd001d721d70a00937fdb31e0915be270801f6f2d48308d718d121f900ed44d0d3ffd31ff404f404d33fd315d1f82321a15220b98e12336df82324aa00a112b9926d32de58f82301de541675f910f2a106d0d31fd4d307d30cd309d33fd315d15168baf2a2515abaf2a6f8232aa15250bcf2a304f823bbf2a35304800df40f6fa199d024d721d70a00f2649130e20e01fe5309800df40f6fa18e13d05004d718d20001f264c858cf16cf8301cf168e1030c824cf40cf8384095005a1a514cf40e2f800c94039800df41704c8cbff13cb1ff40012f40012cb3f12cb15c9ed54f80f21d0d30001f265d3020171b0925f03e0fa4001d70b01c000f2a5fa4031fa0031f401fa0031fa00318060d721d300010f0020f265d2000193d431d19130e272b1fb00b585bf03";

export class HighloadQueryId {
  constructor(value = 0n) {
    this.value = BigInt(value);
  }
  static fromSeqno(seqno) {
    // Highload V3 query id structure: shift and mask
    // Based on TON docs: query_id = seqno + (shift << 13) etc - simplified for Workers
    // Use seqno directly as query_id for first 8M ids (official allows 8380416 ids)
    return new HighloadQueryId(BigInt(seqno));
  }
  static fromShiftAndBitNumber(shift, bitNumber) {
    const v = (BigInt(shift) << 13n) | (1n << BigInt(bitNumber));
    return new HighloadQueryId(v);
  }
  getQueryId() { return this.value; }
  toSeqno() { return this.value; }
  getNext() { return new HighloadQueryId(this.value + 1n); }
  hasNext() { return this.value < 8380416n; }
}

export class HighloadWalletV3 {
  constructor(publicKey, subwalletId = 0x10ad, timeout = 86400) {
    this.publicKey = publicKey;
    this.subwalletId = subwalletId;
    this.timeout = timeout;
    this.code = Cell.fromBoc(Buffer.from(CODE_HEX, 'hex'))[0];
    const data = beginCell()
      .storeUint(0, 1)
      .storeUint(this.subwalletId, 32)
      .storeBuffer(Buffer.from(this.publicKey))
      .storeUint(this.timeout, 22)
      .storeUint(0, 64)
      .storeDict(null)
      .endCell();
    this.address = contractAddress(0, { code: this.code, data });
    this.init = { code: this.code, data };
  }

  static createFromConfig(config, code) {
    const codeCell = code || Cell.fromBoc(Buffer.from(CODE_HEX, 'hex'))[0];
    const data = beginCell()
      .storeUint(0, 1)
      .storeUint(config.subwalletId || 0x10ad, 32)
      .storeBuffer(Buffer.from(config.publicKey))
      .storeUint(config.timeout || 86400, 22)
      .storeUint(0, 64)
      .storeDict(null)
      .endCell();
    const address = contractAddress(0, { code: codeCell, data });
    const inst = new HighloadWalletV3(config.publicKey, config.subwalletId, config.timeout);
    inst.address = address;
    inst.init = { code: codeCell, data };
    return inst;
  }

  async sendExternalMessage(provider, secretKey, params) {
    const { message, mode, query_id, createdAt, subwalletId, timeout } = params;
    const actionsBuilder = beginCell();
    actionsBuilder.storeUint(mode, 8);
    actionsBuilder.storeRef(message);

    const actions = beginCell()
      .storeDict(Dictionary.empty(Dictionary.Keys.Uint(8), Dictionary.Values.Cell()).set(0, actionsBuilder.endCell()))
      .endCell();

    const signingMessage = beginCell()
      .storeUint(subwalletId, 32)
      .storeUint(createdAt, 32)
      .storeUint(query_id.getQueryId(), 64)
      .storeUint(timeout, 22)
      .storeUint(0, 1) // no actions in old dict
      .storeDict(null)
      .storeDict(Dictionary.empty().set(0, actions))
      .endCell();

    // Sign
    const { sign } = await import('@ton/crypto');
    const signature = sign(signingMessage.hash(), secretKey);

    const body = beginCell()
      .storeBuffer(signature)
      .storeUint(subwalletId, 32)
      .storeUint(createdAt, 32)
      .storeUint(query_id.getQueryId(), 64)
      .storeUint(timeout, 22)
      .storeUint(0, 1)
      .storeDict(null)
      .storeDict(Dictionary.empty().set(0, actions))
      .endCell();

    await provider.external(body);
  }

  async sendTransfer(provider, args) {
    // Simplified batch send for Workers - packs up to 254 messages
    const { secretKey, messages } = args;
    const query_id = HighloadQueryId.fromSeqno(BigInt(Date.now() % 8380416));
    const createdAt = Math.floor(Date.now() / 1000) - 30;

    let actionsDict = Dictionary.empty(Dictionary.Keys.Uint(8), Dictionary.Values.Cell());
    for (let i = 0; i < messages.length && i < 254; i++) {
      const msg = messages[i];
      const actionCell = beginCell()
        .storeUint(msg.mode || SendMode.PAY_GAS_SEPARATELY, 8)
        .storeRef(msg.to ? beginCell().storeAddress(msg.to).endCell() : msg.body)
        .endCell();
      // Actually internal() already creates message cell, we store it directly
      const finalAction = beginCell()
        .storeUint(SendMode.PAY_GAS_SEPARATELY, 8)
        .storeRef(msg.body || msg)
        .endCell();
      // For jetton internal, msg is already internal() result with body
      const wrapped = beginCell()
        .storeUint(0, 8)
        .storeRef(messages[i].body ? messages[i].body : beginCell().endCell())
        .endCell();
      // Simplified: store the internal message as action
      actionsDict.set(i, beginCell().storeUint(SendMode.PAY_GAS_SEPARATELY, 8).storeRef(messages[i].to ? beginCell().storeAddress(messages[i].to).endCell() : messages[i]).endCell());
    }

    // Correct packing for Highload V3: actions dict in second dict
    const actionsOuter = Dictionary.empty(Dictionary.Keys.Uint(8), Dictionary.Values.Cell());
    // Build actions cell that contains mode+ref for each
    let idx = 0;
    for (const m of messages) {
      const ac = beginCell()
        .storeUint(SendMode.PAY_GAS_SEPARATELY, 8)
        .storeRef(m)
        .endCell();
      actionsOuter.set(idx++, ac);
    }

    const payload = beginCell()
      .storeUint(this.subwalletId, 32)
      .storeUint(createdAt, 32)
      .storeUint(query_id.getQueryId(), 64)
      .storeUint(this.timeout, 22)
      .storeUint(0, 1)
      .storeDict(null)
      .storeDict(actionsOuter)
      .endCell();

    const { sign } = await import('@ton/crypto');
    const signature = sign(payload.hash(), secretKey);

    const body = beginCell()
      .storeBuffer(signature)
      .storeUint(this.subwalletId, 32)
      .storeUint(createdAt, 32)
      .storeUint(query_id.getQueryId(), 64)
      .storeUint(this.timeout, 22)
      .storeUint(0, 1)
      .storeDict(null)
      .storeDict(actionsOuter)
      .endCell();

    await provider.external(body);
  }
}
