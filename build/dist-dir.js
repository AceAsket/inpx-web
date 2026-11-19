const path = require('node:path');

module.exports = path.resolve(process.env.INPX_BUILD_DIST_DIR || path.join(__dirname, '../dist'));
