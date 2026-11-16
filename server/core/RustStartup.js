const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {executable} = require('./RustPrograms');

const exec = promisify(execFile);

async function run(command, args = [], request) {
    const binary = executable('catalog');
    if (!binary) return null;
    const configRequest = command === 'load-config' || command === 'save-config';
    let output;
    try {
        const task = exec(binary,[command,...args],{windowsHide:true,maxBuffer:4*1024*1024});
        task.child.stdin.on('error',()=>{});
        task.child.stdin.end(request === undefined ? undefined : JSON.stringify(request));
        output = await task;
    } catch (error) {
        const message = error.stderr?.trim();
        if (message?.includes('usage: inpx-catalog') && !message.includes(command)) return null;
        if (command === 'load-config' && error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return null;
        // A failed child can carry partial configuration and secrets in error.stdout.
        if (configRequest) throw new Error(message || 'Rust configuration operation failed');
        if (message) throw new Error(message,{cause:error});
        throw error;
    }
    try { return JSON.parse(output.stdout); }
    catch (error) {
        if (configRequest) throw new Error('Invalid Rust configuration response');
        throw error;
    }
}

module.exports = {run};
