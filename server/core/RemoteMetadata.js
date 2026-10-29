class RemoteMetadata {
    constructor(remote) {
        this.remote = remote;
        this.handshake = null;
        this.ratings = null;
        this.pendingRatings = null;
    }

    async supported(feature = 'metadata') {
        if (!this.handshake) {
            this.handshake = this.remote.wsRequest({action:'get-config'}).then(config => {
                const advertised = config.libraryProtocol;
                if (advertised && (advertised.version !== 1 || !Array.isArray(advertised.features)))
                    throw new Error('Несовместимая версия протокола удалённой библиотеки');
                return advertised || {version:0, features:[]};
            }).catch(error => {this.handshake = null; throw error;});
        }
        return (await this.handshake).features.includes(feature);
    }

    async request(kind, params = {}) {
        return this.remote.wsRequest({action:'get-library-metadata', kind, ...params});
    }

    async reviews(uid) {
        if (!await this.supported()) return [];
        const items = [];
        let cursor = 0;
        while (cursor !== null) {
            const response = await this.request('reviews', {bookUid:uid, cursor});
            if (!Array.isArray(response.items) || response.items.length > 10) throw new Error('Некорректный ответ удалённой библиотеки');
            items.push(...response.items.map(item => ({name:String(item.name || '').slice(0, 300), time:String(item.time || '').slice(0, 100), text:String(item.text || '').slice(0, 16000)})));
            if (response.next !== null && (!Number.isSafeInteger(response.next) || response.next <= cursor || response.next > 10000))
                throw new Error('Некорректная пагинация удалённых отзывов');
            cursor = response.next;
        }
        return items;
    }

    async rating(uid) {
        if (!await this.supported()) return null;
        const {rating} = await this.request('rating', {bookUid:uid});
        return rating && Number.isSafeInteger(rating.count) && rating.count > 0 && Number.isFinite(rating.value) && rating.value > 0 && rating.value <= 5 ? rating : null;
    }

    async author(name) {
        if (!await this.supported()) return null;
        const {authorInfo} = await this.request('author', {author:name});
        return authorInfo ? {html:require('../../shared/safeHtml').safeHtml(String(authorInfo.html || '').slice(0, 128000)),
            text:String(authorInfo.text || '').slice(0, 128000), photo:''} : null;
    }

    async ratingIndex() {
        if (!await this.supported('ratings')) return {signature:'legacy', counts:new Map()};
        if (this.ratings && Date.now() - this.ratings.time < 60000) return this.ratings;
        if (!this.pendingRatings) {
            const read = async() => {
                let cursor = 0, revision;
                const counts = new Map();
                while (cursor !== null) {
                    const response = await this.request('ratings', {cursor, revision});
                    if (!response.revision || revision && response.revision !== revision || !Array.isArray(response.items) || response.items.length > 1000)
                        throw new Error('Индекс удалённой библиотеки изменился или повреждён');
                    revision = response.revision;
                    for (const [uid, count] of response.items) {
                        if (typeof uid !== 'string' || uid.length > 512 || !Number.isSafeInteger(count) || count < 0) throw new Error('Некорректная оценка удалённой книги');
                        counts.set(uid, count);
                    }
                    if (response.next !== null && (!Number.isSafeInteger(response.next) || response.next <= cursor || response.next > 10000000))
                        throw new Error('Некорректная пагинация удалённого индекса');
                    cursor = response.next;
                }
                return (this.ratings = {signature:revision, counts, time:Date.now()});
            };
            this.pendingRatings = read().finally(() => {this.pendingRatings = null;});
        }
        return this.pendingRatings;
    }
}

module.exports = RemoteMetadata;
