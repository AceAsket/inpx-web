const assert = require('assert/strict');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const https = require('https');
const axios = require('axios');
const {promisify} = require('util');
const execFile = promisify(require('child_process').execFile);
const network = require('../shared/TelegramNetwork');

async function temporary(test) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'inpx-telegram-ip-'));
    try {await test(directory);} finally {await fs.remove(directory);}
}

function worker(config = {}) {
    const value = Object.create(require('../server/core/WebWorker').prototype);
    value.config = config;
    value.checkMyState = () => {};
    value.requireAdmin = async() => {};
    value.addAdminEvent = () => {};
    return value;
}

async function testTelegramFamilyValidationAdminSettingsAndBackup() {
    for (const value of [undefined, null, '', 0, '0', ' AUTO ']) assert.equal(network.normalizeIpFamily(value), 'auto');
    for (const family of [4, 6]) assert.deepEqual(network.requestOptions({telegramIpFamily:family}), {family});
    assert.deepEqual(network.requestOptions(), {}, 'Default leaves Node dual-stack behavior unchanged');
    for (const value of ['ipv6', 5, true, [], {}, '6junk', 4.5]) assert.throws(() => network.normalizeIpFamily(value), /auto, 4 или 6/);
    const value = worker({telegramIpFamily:'6', telegramBotToken:'fixture-secret'});
    assert.equal(value.getAdminIntegrationConfig().telegramIpFamily, '6');
    assert.equal(value.getAdminIntegrationConfig().telegramBotToken, '__KEEP__');
    assert.deepEqual(value.normalizeIntegrationPatch({telegramIpFamily:4, telegramBotToken:'__KEEP__'}), {telegramIpFamily:'4'});
    assert.throws(() => value.normalizeIntegrationPatch({telegramIpFamily:'invalid'}), /auto, 4 или 6/);
    assert(value.adminSettingsExportKeys().includes('telegramIpFamily'));
    assert.equal(value.normalizeImportedAdminSettings({settings:{telegramIpFamily:6}}).telegramIpFamily, '6');
    assert.throws(() => value.normalizeImportedAdminSettings({settings:{telegramIpFamily:'invalid'}}), /auto, 4 или 6/);
}

async function testTelegramFamilyPersistsAndEnvironmentOverridesSavedChoice() {
    await temporary(async directory => {
        const configPath = path.join(directory, 'config.json');
        await fs.writeJson(configPath, {dataDir:directory, telegramIpFamily:'4'});
        const script = `
            const fs = require('fs');
            const {createRequire} = require('module');
            const Config = require('./server/config');
            (async()=>{
                const manager = new Config();
                await manager.init(${JSON.stringify(directory)}, ${JSON.stringify(configPath)});
                await manager.load();
                const saved = manager.config.telegramIpFamily;
                await manager.save();
                const indexPath = require.resolve('./server/index.js');
                const source = fs.readFileSync(indexPath, 'utf8');
                const code = source.slice(source.indexOf('function applyEnvSecurityOverrides('), source.indexOf('function applyEnvLibraryOverrides('));
                const apply = new Function('require','process',code+';return applyEnvSecurityOverrides;')(createRequire(indexPath),process);
                const config = manager.config; apply(config);
                console.log(JSON.stringify({saved, persisted:JSON.parse(fs.readFileSync(${JSON.stringify(configPath)},'utf8')).telegramIpFamily, effective:config.telegramIpFamily}));
            })().catch(e=>{console.error(e);process.exitCode=1;});
        `;
        const result = await execFile(process.execPath, ['-e', script], {cwd:path.resolve(__dirname, '..'), env:{...process.env, TELEGRAM_IP_FAMILY:'6'}, windowsHide:true});
        const output = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
        assert.deepEqual(output, {saved:'4', persisted:'4', effective:'6'});
    });
}

async function testTelegramProbeAndDocumentUseSelectedFamilyOverRealHttps() {
    await temporary(async directory => {
        const bookFile = path.join(directory, 'book.fb2'); await fs.writeFile(bookFile, '<FictionBook>fixture text</FictionBook>');
        const certificate = await fs.readFile(path.join(__dirname, 'fixtures/tls/localhost-cert.pem'));
        const key = await fs.readFile(path.join(__dirname, 'fixtures/tls/localhost-key.pem'));
        for (const family of [4, 6]) {
            const requests = [], calls = [];
            const server = https.createServer({key, cert:certificate}, (req, res) => {
                const data = [];
                req.on('data', chunk => data.push(chunk));
                req.on('end', () => {
                    requests.push({method:req.method, addressFamily:req.socket.remoteFamily, body:Buffer.concat(data).toString()});
                    res.setHeader('content-type','application/json'); res.end(JSON.stringify({ok:true,result:{username:'fixture_bot'}}));
                });
            });
            await new Promise((resolve, reject) => {server.once('error',reject); server.listen({host:family === 6 ? '::1' : '127.0.0.1', port:0, ipv6Only:family === 6},resolve);});
            const agent = new https.Agent({ca:certificate});
            const originalGet = axios.get, originalPost = axios.post;
            const endpoint = `https://localhost:${server.address().port}`;
            // Redirect to a loopback fixture without changing the production
            // family option or sending anything to Telegram.
            axios.get = async(url, options) => {calls.push({url, family:options.family, timeout:options.timeout}); return originalGet(endpoint + '/getMe', {...options, proxy:false, httpsAgent:agent});};
            axios.post = async(url, body, options) => {calls.push({url, family:options.family, timeout:options.timeout}); return originalPost(endpoint + '/sendDocument', body, {...options, proxy:false, httpsAgent:agent});};
            try {
                const value = worker({telegramIpFamily:String(family), telegramShareEnabled:true, telegramBotToken:'fixture', telegramCaptionTemplate:'${AUTHOR} - ${TITLE}'});
                value.readingListStore = {getUsers:async() => ({currentUser:{telegramChatId:'fixture-chat'}})};
                value.getDeliveryBookFile = async() => ({book:{title:'Book',author:'Author'},rawFile:bookFile,downFileName:'book.fb2'});
                assert.equal((await value.testAdminIntegrationConfig('admin','fixture','telegram')).success, true);
                assert.equal((await value.sendBookToTelegram('book','','reader')).success, true);
                assert.deepEqual(calls.map(call => call.family), [family,family]);
                assert.deepEqual(calls.map(call => call.timeout), [15000,300000]);
                assert.deepEqual(requests.map(request => request.addressFamily), [family === 6 ? 'IPv6':'IPv4',family === 6 ? 'IPv6':'IPv4']);
                assert.deepEqual(requests.map(request => request.method), ['GET','POST']);
                for (const expected of ['name="chat_id"','fixture-chat','name="caption"','Author - Book','filename="book.fb2"','fixture text']) assert(requests[1].body.includes(expected),expected);
            } finally {
                axios.get = originalGet; axios.post = originalPost; agent.destroy(); server.closeAllConnections();
                await new Promise(resolve => server.close(resolve));
            }
        }
    });
}

module.exports = [testTelegramFamilyValidationAdminSettingsAndBackup, testTelegramFamilyPersistsAndEnvironmentOverridesSavedChoice,
    testTelegramProbeAndDocumentUseSelectedFamilyOverRealHttps];
