const log = new (require('./core/AppLogger'))().log;//singleton

function webpackDevMiddleware(app) {
    const webpack  = require('webpack');
    const wpConfig = require('../build/webpack.dev.config');

    const compiler = webpack(wpConfig);
    const devMiddleware = require('webpack-dev-middleware');
    app.use(devMiddleware(compiler, {
        publicPath: wpConfig.output.publicPath,
        stats: {colors: true}
    }));

    let hotMiddleware = require('webpack-hot-middleware');
    app.use(hotMiddleware(compiler, {
        log: log
    }));
}

function logQueries(app) {
    const {readerBackgroundLogUrl} = require('./core/ReaderAssets');
    app.use(function(req, res, next) {
        const start = Date.now();
        const body = require('./core/SensitiveLog').redact(req.body);
        log(`${req.method} ${readerBackgroundLogUrl(req.originalUrl)} ${JSON.stringify(body ?? '').slice(0, 4000)}`);
        //log(`${JSON.stringify(req.headers, null, 2)}`)
        res.once('finish', () => {
            log(`${Date.now() - start}ms`);
        });
        next();
    });
}

function logErrors(app) {
    app.use(function(err, req, res, next) {// eslint-disable-line no-unused-vars
        log(LM_ERR, err.stack);
        res.status(500).send(err.stack);
    });    
}

module.exports = {
    webpackDevMiddleware,
    logQueries,
    logErrors
};
