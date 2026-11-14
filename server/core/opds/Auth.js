const crypto = require('crypto');

function equal(a, b) {
    const left = Buffer.from(String(a || ''));
    const right = Buffer.from(String(b || ''));
    return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function parseBasicAuth(header = '') {
    const match = String(header).match(/^Basic\s+(.+)$/i);
    if (!match) return null;
    const decoded = Buffer.from(match[1], 'base64').toString('utf8');
    const splitAt = decoded.indexOf(':');
    return splitAt < 0 ? null : {user: decoded.slice(0, splitAt), password: decoded.slice(splitAt + 1)};
}

module.exports = function opdsAuth(config, verifyPassword, security) {
    return async(req, res, next) => {
        try {
            if (req.opdsAuthorized)
                return next();
            const credentials = parseBasicAuth(req.headers.authorization);
            const attempted = !!req.headers.authorization;
            const scopedUser = String((req.query && req.query.user) || '').trim();
            if (!config.opds.password && !scopedUser)
                return next();
            const verify = async () => {
                if (!config.opds.password)
                    return verifyPassword(scopedUser, credentials?.user || '', credentials?.password || '');
                if (!config.opds.user)
                    throw new Error('User must not be empty if password set');
                // A shared password grants catalogue access, not the identity
                // of an enrolled profile when a personal scope is requested.
                if (scopedUser || credentials?.user) {
                    const profile = await verifyPassword(scopedUser, credentials?.user || '', credentials?.password || '', {totpOnly:true});
                    if (profile.user?.profileTotp || profile.user?.otpRequired) return profile;
                }
                return {authorized:!!credentials && equal(credentials.user, config.opds.user) && equal(credentials.password, config.opds.password)};
            };
            const authenticationRequired = auth => Boolean(config.opds.password || auth.requiresAuthentication || auth.user?.opdsAuthEnabled === true);
            const auth = attempted ? await security.withLoginAttempt(req, 'opds', verify,
                result => authenticationRequired(result) ? result.authorized : undefined) : await verify();
            if (auth.user) req.query.user = auth.user.id;
            if (!authenticationRequired(auth)) return next();
            if (!auth.authorized) {
                res.set('WWW-Authenticate', 'Basic realm="inpx-web OPDS", charset="UTF-8"');
                res.set('Cache-Control', 'no-store');
                return res.status(401).send('Authentication required');
            }
            req.opdsAuthorized = true;
            if (auth.user?.profileTotp)
                req.profileAccessIdentity = {user:auth.user, opds:true, bound:true};
            next();
        } catch (error) {
            if (error.code === 'INPX_LOGIN_RATE_LIMIT') {
                res.set('Retry-After', String(error.retryAfter));
                res.set('Cache-Control', 'no-store');
                return res.status(429).send('Too many login attempts. Try again later.');
            }
            next(error);
        }
    };
};

module.exports.parseBasicAuth = parseBasicAuth;
module.exports.equal = equal;
