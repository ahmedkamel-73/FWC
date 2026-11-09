// FWC CLEAN v1 - bot/notifications.js
import { sendMessage, miniAppKeyboard } from './telegram.js';
const APP_URL='https://fwc.ahmed73.workers.dev/';
export async function notifyWithdrawalApproved(env, telegramId, amount, net){
  return sendMessage(env, telegramId, `✅ <b>Withdrawal Approved!</b>\n\nAmount: ${amount} FWC\nYou received: ${net} FWC\n\nCheck your wallet!`, {replyMarkup: miniAppKeyboard(APP_URL)});
}
export async function notifyWithdrawalRejected(env, telegramId, amount, reason=''){
  return sendMessage(env, telegramId, `❌ <b>Withdrawal Rejected</b>\n\nAmount: ${amount} FWC\n${reason? 'Reason: '+reason+'\n':''}Balance returned to your account.`, {replyMarkup: miniAppKeyboard(APP_URL)});
}
export async function notifyMiningReady(env, telegramId, amount){
  return sendMessage(env, telegramId, `⛏️ <b>Mining Ready!</b>\n\nYou can claim ${amount} FWC now.`, {replyMarkup: miniAppKeyboard(APP_URL)});
}
export async function notifyNewTask(env, telegramId, title, reward){
  return sendMessage(env, telegramId, `🎁 <b>New Task!</b>\n\n${title}\nReward: ${reward} FWC`, {replyMarkup: miniAppKeyboard(APP_URL)});
}
