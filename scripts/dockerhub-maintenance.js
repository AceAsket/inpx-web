const fs = require('fs/promises');
const path = require('path');

const repository = 'aceasket/inpx-web-7z';
const hub = 'https://hub.docker.com';
const repositoryPath = `/v2/repositories/${repository}/`;
const shortDescription = 'Каталог и читалка / Ebook catalog & FB2 reader. OPDS, Docker, Silero TTS.';

function cleanupPlan(tags) {
    const versions = new Map();
    for (const tag of tags) {
        const match = /^(\d+)\.(\d+)\.(\d+)-rc\.(\d+)(?:-silero)?$/.exec(tag.name);
        if (!match) continue;
        const numbers = match.slice(1, 5).map(Number);
        versions.set(numbers.join('.'), numbers);
    }
    const newest = [...versions.values()].sort((a, b) => {
        for (let index = 0; index < 4; index++) {
            if (a[index] !== b[index]) return b[index] - a[index];
        }
        return 0;
    }).slice(0, 2);
    if (newest.length < 2) return {keep: tags.map(tag => tag.name), remove: []};
    const keepVersions = new Set(newest.map(version => `${version.slice(0, 3).join('.')}-rc.${version[3]}`));
    for (const version of keepVersions) {
        if (!tags.some(tag => tag.name === version))
            throw new Error(`Main image missing for retained RC: ${version}`);
    }
    const remove = tags.filter(tag => /^\d+\.\d+\.\d+-rc\.\d+(?:-silero)?$/.test(tag.name)
        && !keepVersions.has(tag.name.replace(/-silero$/, ''))).map(tag => tag.name);
    return {keep: tags.filter(tag => !remove.includes(tag.name)).map(tag => tag.name), remove};
}

async function request(urlPath, method = 'GET', body = undefined, token = '') {
    const url = new URL(urlPath, hub);
    if (url.origin !== hub || !url.pathname.startsWith('/v2/')) throw new Error('Unexpected Docker Hub URL');
    const response = await fetch(url, {
        method, redirect: 'error', signal: AbortSignal.timeout(30000),
        headers: {'Content-Type': 'application/json', ...(token ? {Authorization: `Bearer ${token}`} : {})},
        ...(body === undefined ? {} : {body: JSON.stringify(body)}),
    });
    // Never print response bodies or credentials from authentication failures.
    if (!response.ok) throw new Error(`Docker Hub ${method} ${url.pathname}: HTTP ${response.status}`);
    return response.status === 204 ? null : await response.json();
}

async function allTags(token) {
    const tags = [];
    let next = `${repositoryPath}tags?page_size=100`;
    const seen = new Set();
    while (next) {
        if (seen.has(next) || seen.size >= 100) throw new Error('Invalid Docker Hub tag pagination');
        const url = new URL(next, hub);
        if (url.pathname !== `${repositoryPath}tags` && url.pathname !== `${repositoryPath}tags/`)
            throw new Error('Unexpected repository in tag pagination');
        seen.add(next);
        const page = await request(next, 'GET', undefined, token);
        if (!Array.isArray(page.results)) throw new Error('Invalid Docker Hub tag response');
        tags.push(...page.results);
        next = page.next;
    }
    return tags;
}

async function main() {
    const description = await fs.readFile(path.join(__dirname, '../docs/dockerhub.md'), 'utf8');
    if (Buffer.byteLength(description) > 25000 || Buffer.byteLength(shortDescription) > 100)
        throw new Error('Docker Hub description limit exceeded');
    const username = process.env.DOCKERHUB_USERNAME;
    const secret = process.env.DOCKERHUB_TOKEN;
    if (!username || !secret) throw new Error('Docker Hub credentials are required');
    const auth = await request('/v2/auth/token', 'POST', {identifier: username, secret});
    const token = auth.access_token;
    if (typeof token !== 'string' || !token) throw new Error('Docker Hub did not return an access token');
    const before = await request(repositoryPath, 'GET', undefined, token);
    const tags = await allTags(token);
    const plan = cleanupPlan(tags);
    await fs.writeFile('dockerhub-backup.json', JSON.stringify({repository, savedAt: new Date().toISOString(),
        description: before.description, full_description: before.full_description, tags, plan}, null, 2));
    await request(repositoryPath, 'PATCH', {description: shortDescription, full_description: description}, token);
    const updated = await request(repositoryPath, 'GET', undefined, token);
    if (updated.full_description !== description || updated.description !== shortDescription)
        throw new Error('Docker Hub description verification failed');
    console.log(`Published RU/EN description: ${Buffer.byteLength(description)} bytes`);
    if (process.env.CLEANUP_OLD_RC !== 'true') return;
    console.log(`Keep: ${plan.keep.join(', ')}`);
    console.log(`Delete old RC tags: ${plan.remove.join(', ') || 'none'}`);
    for (const name of plan.remove) {
        await request(`${repositoryPath}tags/${encodeURIComponent(name)}/`, 'DELETE', undefined, token);
        console.log(`Deleted ${name}`);
    }
    const after = await allTags(token);
    for (const name of plan.keep) {
        const previous = tags.find(tag => tag.name === name);
        const current = after.find(tag => tag.name === name);
        if (!current || previous.digest !== current.digest)
            throw new Error(`Retained tag changed: ${name}`);
    }
    if (after.some(tag => plan.remove.includes(tag.name))) throw new Error('Old RC tag still present');
    console.log(`Cleanup verified: ${plan.remove.length} deleted; ${plan.keep.length} retained with original digests`);
}

module.exports = {cleanupPlan};
if (require.main === module) main().catch(error => {console.error(error.message); process.exitCode = 1;});
