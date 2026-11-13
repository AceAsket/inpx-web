const crypto = require('crypto');

const maximumProfiles = 512;
const events = {logins: 'profile_login', downloads: 'book_download'};

class ServerActivity {
    constructor(config, key, log) {
        this.config = config;
        this.key = key;
        this.log = log;
        this.profiles = new Map([['guest', {logins: 0, downloads: 0}]]);
    }

    record(userId, field, count = 1) {
        const profile = userId
            ? crypto.createHmac('sha256', this.key).update('server-activity\0').update(userId).digest('hex').slice(0, 12)
            : 'guest';
        if (this.config.loggingEnabled)
            this.log(`activity event=${events[field]} profile=${profile} count=${count}`);

        const label = this.profiles.has(profile) || this.profiles.size < maximumProfiles + 1 ? profile : 'other';
        if (!this.profiles.has(label)) this.profiles.set(label, {logins: 0, downloads: 0});
        this.profiles.get(label)[field] += count;
    }

    snapshot() {
        const totals = {logins: 0, downloads: 0};
        const profiles = [];
        for (const [profile, counts] of this.profiles) {
            if (!counts.logins && !counts.downloads) continue;
            totals.logins += counts.logins;
            totals.downloads += counts.downloads;
            profiles.push({profile, ...counts});
        }
        profiles.sort((a, b) => b.downloads - a.downloads || b.logins - a.logins || a.profile.localeCompare(b.profile));
        return {totals, profiles};
    }

    samples(field) {
        return Array.from(this.profiles, ([profile, totals]) => ({labels: {profile}, value: totals[field]}));
    }
}

function countDownload(res, record) {
    res.once('finish', () => {
        const range = /^bytes 0-(\d+)\/(\d+)$/.exec(res.getHeader('Content-Range'));
        const wholeRange = res.statusCode === 206 && range && Number(range[1]) + 1 === Number(range[2]);
        if (res.statusCode === 200 || wholeRange) record();
    });
}

module.exports = {ServerActivity, countDownload};
