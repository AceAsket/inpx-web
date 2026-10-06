const fs = require('fs-extra');
const iconv = require('iconv-lite');
const {isUtf8} = require('buffer');
const textUtils = require('./textUtils');

const Fb2Parser = require('../fb2/Fb2Parser');
const utils = require('../utils');

class Fb2Helper {
    async decompressIfNeeded(data) {
        if (data && data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b)
            return await utils.gunzipBuffer(data);

        return data;
    }

    checkEncoding(data) {
        if (!Buffer.isBuffer(data) || !data.length)
            return data;

        // A BOM or the XML byte order is reliable even when a language-based
        // detector mistakes UTF-16 for a single-byte encoding.
        let encoding = '';
        if ((data[0] === 0xff && data[1] === 0xfe) || (data[0] === 0x3c && data[1] === 0 && data[3] === 0))
            encoding = 'utf-16le';
        else if ((data[0] === 0xfe && data[1] === 0xff) || (data[0] === 0 && data[1] === 0x3c && data[2] === 0))
            encoding = 'utf-16be';

        if (!encoding) {
            const head = data.subarray(0, 1024).toString('latin1');
            const declaration = head.match(/^\s*<\?xml\b[^?]*\?>/i);
            const declared = declaration && declaration[0].match(/\bencoding\s*=\s*(['"])([^'"]+)\1/i);
            // FLibrary can retain a legacy declaration on UTF-8 bytes. Validate
            // the bytes first; otherwise honour XML instead of guessing by prose.
            if (isUtf8(data)) {
                encoding = 'utf-8';
            } else if (declared && !/^utf-?8$/i.test(declared[2])) {
                if (!iconv.encodingExists(declared[2]))
                    throw new Error(`Неподдерживаемая кодировка FB2: ${declared[2]}`);
                encoding = declared[2];
            } else {
                encoding = textUtils.getEncoding(data);
            }
        }

        let text = iconv.decode(data, encoding).replace(/^\uFEFF/, '').trimStart();
        text = text.replace(/^<\?xml\b[^?]*\?>/i, declaration =>
            declaration.replace(/\bencoding\s*=\s*(['"])[^'"]+\1/i, 'encoding="utf-8"'));
        return Buffer.from(text, 'utf8');
    }

    async getDescAndCover(bookFile) {
        let data = await fs.readFile(bookFile);
        data = await this.decompressIfNeeded(data);

        data = this.checkEncoding(data);

        const parser = new Fb2Parser();

        parser.fromString(data.toString(), {
            lowerCase: true,
        });

        const coverImage = parser.$$('/description/title-info/coverpage/image');

        let cover = null;
        let coverExt = '';
        if (coverImage.count) {
            const coverAttrs = coverImage.attrs();
            const href = coverAttrs[`${parser.xlinkNS}:href`];

            if (href) {
                const binaryId = (href[0] == '#' ? href.substring(1) : href);

                //найдем нужный image
                for (const node of parser.$$array('/binary')) {
                    let attrs = node.attrs();
                    if (!attrs)
                        return;

                    if (attrs.id === binaryId) {
                        let coverType = attrs['content-type'];
                        coverType = (coverType == 'image/jpg' || coverType == 'application/octet-stream' ? 'image/jpeg' : coverType);
                        coverExt = (coverType == 'image/png' ? '.png' : '.jpg');

                        const base64 = node.text();
                        cover = (base64 ? Buffer.from(base64, 'base64') : null);
                    }
                }
            }
        }

        return {fb2: parser, cover, coverExt};
    }
}

module.exports = Fb2Helper;
