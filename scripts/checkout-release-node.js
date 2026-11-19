const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {version, classicNodeRevision} = require('../package.json');

// RCs used the Node.js compatibility server from the release checkout.
if (version === '1.8.3') {
    if (!/^[a-f0-9]{40}$/.test(classicNodeRevision || ''))
        throw new Error('1.8.3 requires a pinned classic Node.js revision');
    const directory = process.argv[2];
    const git = (...args) => execFileSync('git', args, {stdio:'inherit'});
    git('fetch', '--no-tags', 'origin', classicNodeRevision);
    if (directory === '.') git('checkout', '--detach', classicNodeRevision);
    else git('worktree', 'add', '--detach', directory, classicNodeRevision);
    const source = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
    if (source.version !== version || fs.existsSync(path.join(directory, 'rust', 'Cargo.toml')))
        throw new Error('Expected the matching classic Node.js release with JembaDB');
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `directory=${directory}\nclassic=true\n`);
}
