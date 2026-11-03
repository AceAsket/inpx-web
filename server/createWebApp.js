module.exports = async(config, options = {}) => {
    const bundle = options.bundle || require('../dist/public.json');
    return require('./core/WebAppFiles').install(config, bundle);
};
