const maxAgeMs = 30*24*60*60*1000;
const idleMs = 7*24*60*60*1000;
const maxSessions = 10000;
const lastSweep = new WeakMap();

function expired(session, now = Date.now()) {
    return !session || !Number.isFinite(session.createdAt)
        || now - session.createdAt >= maxAgeMs
        || now - session.updatedAt >= idleMs;
}

function makeRoom(sessions, now = Date.now()) {
    if (now - (lastSweep.get(sessions) || 0) >= 60*1000 || sessions.size >= maxSessions) {
        for (const [key, session] of sessions) {
            if (expired(session, now))
                sessions.delete(key);
        }
        lastSweep.set(sessions, now);
    }
    while (sessions.size >= maxSessions)
        sessions.delete(sessions.keys().next().value);
}

module.exports = {expired, makeRoom, maxAgeMs, idleMs, maxSessions};
