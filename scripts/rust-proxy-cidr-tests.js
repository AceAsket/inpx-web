const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const {randomBytes} = require('node:crypto');
const fs = require('node:fs/promises');
const {tmpdir} = require('node:os');
const {join} = require('node:path');
const {setTimeout:sleep} = require('node:timers/promises');
const {createFixture} = require('./binary-smoke-test');

const IMAGE_FOR_PROBES = 'node:24-bookworm-slim';
const probe = `const http = require('node:http');
const [base, type] = process.argv.slice(1);
const host = 'books.cidr-fixture.test';
const headers = type === 'ready' ? {} : {
    Host: host, Origin: 'https://' + (type === 'foreign' ? 'other.test' : host),
    'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '198.51.100.20',
    Connection: 'Upgrade', Upgrade: 'websocket',
    'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ=='
};
const request = http.get(base + (type === 'ready' ? '/ready' : '/ws'), {headers, timeout:1500}, res => {
    res.resume(); console.log(res.statusCode);
});
request.on('upgrade',(res,socket) => {socket.destroy(); console.log(res.statusCode);});
request.on('timeout',() => request.destroy());
request.on('error',() => console.log('0'));`;

function docker(...args) {
    return execFileSync('docker', args, {encoding:'utf8', windowsHide:true, stdio:['ignore','pipe','pipe']}).trim();
}

async function main(image) {
    assert(image,'Pass the Rust Docker image to test');
    const root = await fs.mkdtemp(join(tmpdir(),'inpx-proxy-cidrs-'));
    const network = `inpx-test-cidr-${randomBytes(6).toString('hex')}`;
    const client = network+'-client', app = network+'-server';
    let networkCreated = false, clientStarted = false, serverStarted = false;
    const addresses = name => {
        const settings = JSON.parse(docker('inspect','-f','{{json .NetworkSettings.Networks}}',name))[network];
        assert(settings.IPAddress && settings.GlobalIPv6Address,'Expected both Docker address families');
        return [settings.IPAddress,settings.GlobalIPv6Address];
    };
    const stopServer = () => {
        if (serverStarted) {
            docker('rm','-f',app);
            serverStarted = false;
        }
    };
    const request = (base,type) => Number(docker('exec',client,'node','-e',probe,base,type));

    try {
        await createFixture(root);
        docker('network','create','--internal','--ipv6',network);
        networkCreated = true;
        docker('run','--rm','-d','--name',client,'--network',network,'--entrypoint','sleep',IMAGE_FOR_PROBES,'600');
        clientStarted = true;
        const [ipv4,ipv6] = addresses(client);
        const cidrs = [`${ipv4}/32`,`${ipv6}/128`];
        for (const [label,configCidrs,envCidrs,expected4,expected6] of [
            ['CSV config',cidrs.join(', '),null,101,101],
            ['Array config',cidrs,null,101,101],
            ['Mixed environment override',[],cidrs.join(', '),101,101],
            ['IPv6-only environment override',cidrs,cidrs[1],403,101],
            ['IPv4-only environment override',cidrs,cidrs[0],101,403],
        ]) {
            await fs.writeFile(join(root,'proxy.json'), JSON.stringify({authMode:'local',trustProxy:true,trustedProxyCidrs:configCidrs}));
            const env = envCidrs === null ? [] : ['-e',`INPX_TRUSTED_PROXY_CIDRS=${envCidrs}`];
            docker('run','-d','--name',app,'--network',network,...env,
                '--mount',`type=bind,src=${root},target=/library,readonly`,image,'sh','-ec',
                'mkdir -p /data && cp /library/proxy.json /data/config.json && exec inpx-web --data-dir=/data --lib-dir=/library --inpx=/library/smoke.inpx --host=:: --admin-password=docker-cidr-fixture');
            serverStarted = true;
            const [app4,app6] = addresses(app);
            const base4 = `http://${app4}:12380`, base6 = `http://[${app6}]:12380`;
            try {
                for (let attempt=0;attempt<60;attempt++) {
                    if (request(base4,'ready')===200) break;
                    if (attempt===59) assert.fail('Rust container did not become ready');
                    await sleep(200);
                }
                assert.equal(request(base4,'ws'),expected4,`${label} IPv4`);
                assert.equal(request(base6,'ws'),expected6,`${label} IPv6`);
                assert.equal(request(base4,'foreign'),403,`${label} foreign Origin IPv4`);
                assert.equal(request(base6,'foreign'),403,`${label} foreign Origin IPv6`);
                console.log(`ok Docker ${label}: IPv4 ${expected4}, IPv6 ${expected6}, foreign Origin 403`);
            } catch (error) {
                console.error(docker('logs','--tail','20',app));
                throw error;
            } finally {stopServer();}
        }
    } finally {
        stopServer();
        if (clientStarted) docker('rm','-f',client);
        if (networkCreated) docker('network','rm',network);
        await fs.rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:200});
    }
}

main(process.argv[2]).catch(error => {console.error(error);process.exitCode=1;});
