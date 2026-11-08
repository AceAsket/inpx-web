const assert = require('assert/strict');
const path = require('path');
const {loadClient} = require('./catalog-list-filter-tests');
const {telegramProbeNotice} = require('../client/components/Search/SettingsDialog/telegramStatusModel');

async function testNotificationsRenderPlainTextInThemeAndKeepReaderOverrides() {
    const Type = loadClient(path.resolve(__dirname,'../client/components/share/Notify.vue')).default;
    const value = new Type(), notices = [], dismiss = () => {};
    value.$q = {notify: options => {notices.push(options);return dismiss;}};
    const text = '<img src=x onerror="alert(1)">';
    assert.equal(value.success(text,'<b>caption</b>'),dismiss);
    assert.equal(notices[0].html,false);assert.equal(notices[0].message,text);assert.equal(notices[0].caption,'<b>caption</b>');
    assert.equal(notices[0].position,'bottom-right');assert.equal(notices[0].classes,'app-notification app-notification--success');
    assert.equal(notices[0].attrs.role,'status');assert.equal(notices[0].actions[0]['aria-label'],'Закрыть уведомление');
    value.error('Failure');assert.equal(notices[1].attrs.role,'alert');assert(notices[1].classes.endsWith('--error'));
    value.success('Reader','',{position:'bottom',style:'background:var(--reader-surface)',messageColor:'var(--reader-text)',captionColor:'var(--reader-text)'});
    assert.equal(notices[2].position,'bottom');assert(notices[2].attrs.style.includes('background:var(--reader-surface)'));
    assert(notices[2].attrs.style.includes('color:var(--reader-text)'));
}

async function testTelegramTokenProbeDoesNotClaimPollingIsHealthy() {
    const result = {success:true,username:'fixture_bot'};
    const failed = telegramProbeNotice(result,{state:'error',error:'Polling unavailable'},true);
    assert.equal(failed.kind,'warning');assert(failed.message.includes('не подключён'));assert(failed.caption.includes('Polling unavailable'));
    const connecting = telegramProbeNotice(result,{state:'connecting'},true);
    assert.equal(connecting.kind,'info');assert(connecting.caption.includes('подключается'));
    assert.equal(telegramProbeNotice(result,null,true).kind,'info');
    const running = telegramProbeNotice(result,{state:'running'},true);
    assert.equal(running.kind,'success');assert(running.message.includes('принимает сообщения'));
    assert.equal(telegramProbeNotice(result,{state:'disabled'},false).kind,'success');
}

async function testTelegramStatusErrorRemainsDataInsideSuccessfulWebSocketReply() {
    const Type = require('../server/controllers/WebSocketController'), value = Object.create(Type.prototype), replies = [];
    const health = {state:'error',error:'Polling unavailable',enabled:true,username:'fixture_bot'};let reads = 0;
    value.config = {};value.webAccess = {hasAccess:async() => true};
    value.webWorker = {requireAdmin:async user => {if(user !== 'admin')throw new Error('admin_required');},
        getTelegramBot:() => {reads++;return {status:() => ({...health})};}};
    const socket = {readyState:require('ws').OPEN,send:raw => replies.push(JSON.parse(raw))};
    await value.onMessage(socket,JSON.stringify({requestId:'probe',action:'admin-telegram-bot-status',userId:'admin'}));
    assert.equal(replies.at(-1).error,undefined,'Polling failure is not a failed WebSocket request');
    assert.deepEqual(replies.at(-1).telegramBotStatus,health);assert.equal(replies.at(-1).requestId,'probe');
    await value.onMessage(socket,JSON.stringify({action:'admin-telegram-bot-status',userId:'guest'}));
    assert.equal(replies.at(-1).error,'admin_required');assert.equal(reads,1,'Guests cannot read the administrative health');
}

module.exports = [testNotificationsRenderPlainTextInThemeAndKeepReaderOverrides,testTelegramTokenProbeDoesNotClaimPollingIsHealthy,
    testTelegramStatusErrorRemainsDataInsideSuccessfulWebSocketReply];
