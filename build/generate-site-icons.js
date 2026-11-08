// Render site icons from the Android brand SVG used by the header.
// Uses the optional Playwright/Chromium runtime from the browser UI checks.
const fs = require('fs/promises');
const path = require('path');
const {chromium} = require(process.env.INPX_PLAYWRIGHT_MODULE || 'playwright');

async function main() {
    const assets = path.resolve(__dirname, '../client/assets');
    const svg = await fs.readFile(path.join(assets, 'shelves-icon.svg'), 'utf8');
    const browser = await chromium.launch({headless: true, executablePath: process.env.INPX_CHROMIUM_PATH || undefined});
    try {
        const page = await browser.newPage();
        const render = async size => Buffer.from(await page.evaluate(async({svg, size}) => {
            const image = new Image(); image.src = 'data:image/svg+xml;base64,' + btoa(svg); await image.decode();
            const canvas = document.createElement('canvas'); canvas.width = canvas.height = size;
            canvas.getContext('2d').drawImage(image, 0, 0, size, size);
            return canvas.toDataURL('image/png').split(',')[1];
        }, {svg, size}), 'base64');
        for (const size of [192, 512]) await fs.writeFile(path.join(assets, `pwa-icon-${size}.png`), await render(size));
        const sizes = [16, 32, 48, 64, 256], entries = [], header = Buffer.alloc(6 + sizes.length * 16);
        header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
        let offset = header.length;
        for (let index = 0; index < sizes.length; index++) {
            const size = sizes[index], png = await render(size), entry = 6 + index * 16;
            header[entry] = header[entry + 1] = size === 256 ? 0 : size;
            header.writeUInt16LE(1, entry + 4); header.writeUInt16LE(32, entry + 6);
            header.writeUInt32LE(png.length, entry + 8); header.writeUInt32LE(offset, entry + 12);
            entries.push(png); offset += png.length;
        }
        await fs.writeFile(path.join(assets, 'favicon.ico'), Buffer.concat([header, ...entries]));
        await fs.writeFile(path.join(assets, 'pwa-icon.svg'), svg);
        console.log('Generated site SVG, PNG 192/512 and ICO 16/32/48/64/256 from shelves-icon.svg');
    } finally {await browser.close();}
}
main().catch(error => {console.error(error); process.exitCode = 1;});
