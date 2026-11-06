const axios = require('axios');
const {requestOptions} = require('../../shared/TelegramNetwork');

class TelegramBotApi {
    constructor(config, token) {this.network = requestOptions(config); this.token = token;}
    async call(method, data = {}, signal, timeout = 20000) {
        try {
            const response = await axios.post(`https://api.telegram.org/bot${this.token}/${method}`, data, {
                ...this.network, signal, timeout, maxContentLength: 2 * 1024 * 1024,
            });
            if (response.data?.ok !== true) {
                const invalid = new Error('Telegram rejected the request');
                invalid.response = {status: 502, data: response.data}; throw invalid;
            }
            return response.data.result;
        } catch (cause) {
            if (signal?.aborted) throw signal.reason || new Error('Telegram остановлен');
            const description = cause.response?.data?.description;
            const message = typeof description === 'string' ? description.split(this.token).join('[token]').slice(0, 240) : 'Telegram API недоступен';
            const error = new Error(message);
            error.status = Number(cause.response?.status) || 502;
            error.retryAfter = Math.min(120, Math.max(1, Number(cause.response?.data?.parameters?.retry_after) || 0));
            throw error;
        }
    }
}
module.exports = TelegramBotApi;
