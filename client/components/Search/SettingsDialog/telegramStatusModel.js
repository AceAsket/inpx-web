function telegramProbeNotice(result = {}, status = null, enabled = false) {
    const identity = result.username ? `@${result.username}` : '';
    if (enabled && status?.state === 'error') return {kind:'warning',
        message:'Токен Telegram проверен, но интерактивный бот не подключён',
        caption:[identity,status.error || 'Проверьте состояние приёма сообщений ниже.'].filter(Boolean).join(' · ')};
    if (enabled && status?.state === 'running') return {kind:'success',message:'Telegram подключён, бот принимает сообщения',caption:identity};
    if (enabled) return {kind:'info',message:'Токен Telegram проверен',
        caption:[identity,status?.state === 'connecting' ? 'Бот подключается. Состояние приёма сообщений обновится ниже.'
            : status?.state === 'disabled' ? 'Интерактивный бот выключен.' : 'Состояние приёма сообщений пока не подтверждено.'].filter(Boolean).join(' · ')};
    return {kind:'success',message:'Подключение к Telegram проверено',caption:identity};
}
module.exports = {telegramProbeNotice};
