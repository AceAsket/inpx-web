const {getFileLock,releaseFileLock} = require('jembadb/src/utils');

async function lock(directory) {
    const watcher = await getFileLock(directory,true);
    return () => releaseFileLock(directory,watcher);
}

module.exports = {lock};
