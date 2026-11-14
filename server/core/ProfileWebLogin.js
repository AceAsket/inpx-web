const express = require('express');

const cookieName = 'inpx_web_trusted_device';

function register(app, config, worker, security, webAccess, profileAccess) {
    const root = config.rootPathStatic || '';
    const json = express.json({limit:'32kb', inflate:false});

    app.post(`${root}/api/profile/login`, (req, res, next) => {
        res.set('Cache-Control', 'no-store');
        const session = security.secureBrowserSession(req);
        if (!session || profileAccess.bindingEnabled)
            return res.status(403).json({error:'Вход через эту форму недоступен', code:'profile_web_login_unavailable'});
        res.locals.profileLoginSession = session;
        return next();
    }, json, async(req, res) => {
        const {login, password, otp = '', rememberDevice, csrfToken, accessToken} = req.body || {};
        if (typeof csrfToken !== 'string' || !security.hasValidCsrf(req, csrfToken))
            return res.status(403).json({error:'Обновите страницу и повторите вход', code:'bad_csrf_token'});
        if (typeof login !== 'string' || login.length > 100 || typeof password !== 'string' || password.length > 4096
            || typeof otp !== 'string' || otp.length > 64)
            return res.status(400).json({error:'Некорректные данные для входа'});

        try {
            if (!await webAccess.hasAccess(typeof accessToken === 'string' ? accessToken : ''))
                return res.status(401).json({error:'Требуется пароль библиотеки', code:'need_access_token'});
            const trustedDeviceToken = security.parseCookies(req.headers.cookie)[cookieName];
            const {trustedDeviceToken:issuedToken, trustedDeviceMaxAge, ...profile} = await security.withLoginAttempt(req, 'profile',
                () => worker.loginUserProfile(login, password, otp, {trustedDeviceToken, rememberDevice:rememberDevice === true}));
            res.locals.profileLoginSession.profileAccessToken = profile.profileAccessToken;
            if (issuedToken)
                res.cookie(cookieName, issuedToken, {httpOnly:true, secure:true, sameSite:'strict', path:root || '/', maxAge:trustedDeviceMaxAge * 1000});
            return res.json(profile);
        } catch (error) {
            if (['need_profile_otp', 'need_profile_otp_setup', 'INPX_INVALID_PROFILE_CREDENTIALS'].includes(error.code))
                return res.status(401).json({error:error.message, code:error.code});
            if (error.code === 'INPX_LOGIN_RATE_LIMIT')
                return res.set('Retry-After', String(error.retryAfter)).status(429).json({error:error.message, code:error.code});
            if (error.message === 'server_busy')
                return res.status(503).json({error:'Библиотека пока не готова. Повторите вход позже.', code:error.message});
            return res.status(500).json({error:'Не удалось войти в профиль'});
        }
    }, (error, req, res, next) => { // eslint-disable-line no-unused-vars
        return res.status(error.status === 413 ? 413 : 400).json({error:'Некорректные данные для входа'});
    });
}

module.exports = {register};
