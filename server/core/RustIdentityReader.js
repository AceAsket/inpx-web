const {spawn} = require('node:child_process');
const {createInterface} = require('node:readline');

async function readBookIdentities(binary, directory, count, physicalIdentity, consume) {
    const child = spawn(binary, ['book-identities', directory], {windowsHide:true, stdio:['ignore','pipe','pipe']});
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', data => {stderr = (stderr + data).slice(-2048);});
    const done = new Promise(resolve => {
        child.once('error', resolve);
        child.once('close', (code, signal) => resolve(code === 0 ? null :
            new Error(stderr.trim() || `Rust identity reader exited (${signal || code})`)));
    });
    const lines = createInterface({input:child.stdout, crlfDelay:Infinity});
    let header = false, received = 0;
    try {
        for await (const line of lines) {
            const frame = JSON.parse(line);
            if (!header) {
                if (frame?.records !== count) throw new Error('Rust book identity count differs from JembaDB');
                header = true;
            } else {
                if (!Array.isArray(frame) || !frame.length || frame.length > 512 || received + frame.length > count)
                    throw new Error('Invalid Rust book identity batch');
                received += frame.length;
                await consume(frame.map(parts => {
                    if (!Array.isArray(parts) || parts.length !== 5 || typeof parts[1] !== 'string')
                        throw new Error('Unsupported Rust book identity fields');
                    const [id,uid,legacyUid,hash,details] = parts;
                    if (typeof details === 'string') return {id,uid,legacyUid,hash,identity:details};
                    if (!Array.isArray(details) || details.length !== 7 || !details.every(value => value === null || typeof value !== 'object'))
                        throw new Error('Unsupported Rust book identity metadata');
                    const [sourceId,folder,file,ext,insno,libid,sourcelib] = details;
                    return {id,uid,legacyUid,hash,identity:physicalIdentity({sourceId,folder,file,ext,insno,libid,sourcelib})};
                }));
            }
        }
        const error = await done;
        if (error) throw error;
        if (!header || received !== count) throw new Error('Incomplete Rust book identity stream');
    } finally {
        lines.close();
        if (child.exitCode === null && child.signalCode === null) child.kill();
        await done;
    }
}

module.exports = readBookIdentities;
