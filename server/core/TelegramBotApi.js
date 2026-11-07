const axios = require('axios');
const transport = require('./TelegramTransport');

class TelegramBotApi {
    constructor(config, token) {this.config = config; this.token = token;}
    async call(method, data = {}, signal, timeout = 20000) {
        let network;
        try {
            network=transport.requestOptions(this.config,{timeout});
            const response = await axios.post(`https://api.telegram.org/bot${this.token}/${method}`, data, {
                ...network, signal, timeout, maxContentLength: 2 * 1024 * 1024,
            });
            if (response.data?.ok !== true) {
                const invalid = new Error('Telegram rejected the request');
                invalid.response = {status: 502, data: response.data}; throw invalid;
            }
            return response.data.result;
        } catch (cause) {
            if (signal?.aborted) throw signal.reason || new Error('Telegram остановлен');
            throw transport.safeError(cause,this.config,this.token);
        } finally {network?.httpsAgent?.destroy();}
    }
}
module.exports = TelegramBotApi;
