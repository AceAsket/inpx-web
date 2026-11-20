const assert = require('assert');
const fs = require('fs');
const {cleanupPlan} = require('./dockerhub-maintenance');

const names = ['latest', 'dev', 'lite', '1.7.8', '1.7.2-lite', '1.6.9-rc.4', '1.7.8-rc.7',
    '1.7.9-rc.9', '1.7.9-rc.9-silero', '1.7.9-rc.10', '1.7.9-rc.10-silero',
    '1.7.9-rc.11', '1.7.9-rc.11-silero', '1.7.9-rc.12', '1.7.9-rc.12-silero', 'custom-rc.1'];
const tags = names.map(name => ({name, digest: 'shared-digest'}));
const plan = cleanupPlan(tags);
assert.deepStrictEqual(plan.remove, ['1.6.9-rc.4', '1.7.8-rc.7', '1.7.9-rc.9', '1.7.9-rc.9-silero', '1.7.9-rc.10', '1.7.9-rc.10-silero']);
assert.deepStrictEqual(plan.keep, ['latest', 'dev', 'lite', '1.7.8', '1.7.2-lite',
    '1.7.9-rc.11', '1.7.9-rc.11-silero', '1.7.9-rc.12', '1.7.9-rc.12-silero', 'custom-rc.1']);
assert.deepStrictEqual(cleanupPlan([{name: '1.7.9-rc.1'}]).remove, []);
assert.throws(() => cleanupPlan([{name: '1.7.9-rc.12-silero'}, {name: '1.7.9-rc.11'}]), /Main image missing/);
const next = cleanupPlan([...tags, {name: '1.8.0-rc.1'}, {name: '1.8.0-rc.1-silero'}]);
assert(next.keep.includes('1.7.9-rc.12-silero'));
assert(next.keep.includes('1.8.0-rc.1'));
assert(next.remove.includes('1.7.9-rc.11'));
const rustTags = ['latest', '1.8.2', '1.8.3-rc.15', '1.8.3-rc.15-silero',
    '1.8.3-rc.24', '1.8.3-rc.24-rust', '1.8.3-rc.24-silero', '1.8.3-rc.24-custom',
    '1.8.3-rc.25', '1.8.3-rc.25-rust', '1.8.3-rc.25-silero',
    '1.8.3-rc.26', '1.8.3-rc.26-rust', '1.8.3-rc.26-silero'];
const rustPlan = cleanupPlan(rustTags.map(name => ({name})));
assert.deepStrictEqual(rustPlan.remove, ['1.8.3-rc.15-silero', '1.8.3-rc.24', '1.8.3-rc.24-rust', '1.8.3-rc.24-silero']);
assert(rustPlan.keep.includes('1.8.3-rc.15'));
const retired = [...tags, {name: 'dev-lite'}, {name: 'lite-custom'}];
assert.deepStrictEqual(cleanupPlan(retired, {oldRc: false, lite: true}).remove, ['lite', '1.7.2-lite', 'dev-lite']);
assert.deepStrictEqual(cleanupPlan(retired, {oldRc: false}).remove, []);
assert.deepStrictEqual(cleanupPlan([{name: '1.8.2'}, {name: 'lite'}], {lite: true}).remove, ['lite']);
assert.deepStrictEqual(cleanupPlan(retired, {lite: true}).remove.sort(), [...plan.remove, 'lite', '1.7.2-lite', 'dev-lite'].sort());
const readme = fs.readFileSync('docs/dockerhub.md', 'utf8');
const stableTag = readme.match(/^\| `(\d+\.\d+\.\d+)`, `latest` \|/m);
assert(!readme.includes('`lite`') && stableTag && readme.includes('| `1.8.3` |'));
const {version} = require('../package.json');
if (!version.includes('-')) assert.equal(stableTag[1], version);
assert(Buffer.byteLength(readme) <= 25000);
assert(readme.includes('## Русский') && readme.includes('## English'));
console.log('Docker Hub: stable/custom tags protected, RC pairs retained, numeric version ordering and description limits passed');
