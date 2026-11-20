// Standalone Rust scopes the cookie by port. The classic Node.js server uses the original name.
function sessionCookieHeader(response) {
    return response.headers.getSetCookie().find(value => /^inpx_web_session(?:_\d+)?=/.test(value));
}

module.exports = {sessionCookieHeader};
