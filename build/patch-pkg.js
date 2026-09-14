const fs = require('fs');

// pkg 6.22.0 replaces realpath.native with the JS implementation, which leaves
// Windows 8.3 aliases intact. Keep the native implementation for real files;
// snapshot paths must still go through pkg's virtual filesystem.
module.exports = function patchPkg() {
    const filename = require.resolve('@yao-pkg/pkg/prelude/bootstrap.js');
    const marker = '// inpx-web: preserve native realpath';
    let source = fs.readFileSync(filename, 'utf8');
    if (source.includes(marker))
        return;
    const replacements = [
        ['  ancestor.realpathSync.native = fs.realpathSync;\n  ancestor.realpath.native = fs.realpath;',
            `  ${marker}
  const nativeRealpathSync = fs.realpathSync.native;
  const nativeRealpath = fs.realpath.native;`],
        ['  fs.realpathSync.native = fs.realpathSync;\n  fs.realpath.native = fs.realpath;',
            `  fs.realpathSync.native = function(path_) {
    return (insideSnapshot(path_) ? fs.realpathSync : nativeRealpathSync).apply(fs, arguments);
  };
  fs.realpath.native = function(path_) {
    return (insideSnapshot(path_) ? fs.realpath : nativeRealpath).apply(fs, arguments);
  };`],
    ];
    source = source.replace(/\r\n/g, '\n');
    for (const [before, after] of replacements) {
        if (source.split(before).length !== 2)
            throw new Error('pkg bootstrap changed; review the native realpath compatibility patch');
        source = source.replace(before, after);
    }
    fs.writeFileSync(filename, source);
};
