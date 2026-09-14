const assert = require('assert');
const http = require('http');
const axios = require('axios');
const FormData = require('form-data');
const nodemailer = require('nodemailer');

async function testMultipartUploadWithUpdatedAxios() {
    let received;
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            received = {headers: req.headers, body: Buffer.concat(chunks).toString()};
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ok: true}));
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        const form = new FormData();
        form.append('chat_id', 'local-fixture');
        form.append('document', Buffer.from('test-book-content'), {filename: 'test.fb2'});
        const result = await axios.post(`http://127.0.0.1:${server.address().port}`, form, {
            headers: form.getHeaders(), proxy: false, timeout: 5000,
            maxBodyLength: Infinity, maxContentLength: Infinity,
        });
        assert.strictEqual(result.data.ok, true);
        assert.match(received.headers['content-type'], /^multipart\/form-data; boundary=/);
        assert.ok(received.body.includes('local-fixture'));
        assert.ok(received.body.includes('filename="test.fb2"'));
        assert.ok(received.body.includes('test-book-content'));
    } finally {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
}

async function testMailAttachmentWithUpdatedNodemailer() {
    // Generate MIME locally; this transport never contacts an email service.
    const transport = nodemailer.createTransport({streamTransport: true, buffer: true});
    try {
        const result = await transport.sendMail({
            from: 'fixture@example.invalid', to: 'reader@example.invalid',
            subject: 'Книга: Тест', text: 'Локальная проверка вложения.',
            attachments: [{filename: 'book.fb2', content: Buffer.from('test-book-content')}],
        });
        const message = result.message.toString();
        assert.match(message, /multipart\/mixed/);
        assert.match(message, /filename=book.fb2|filename="book.fb2"/);
        assert.ok(message.includes(Buffer.from('test-book-content').toString('base64')));
        assert.strictEqual(result.envelope.to[0], 'reader@example.invalid');
    } finally {
        transport.close();
    }
}

module.exports = [testMultipartUploadWithUpdatedAxios, testMailAttachmentWithUpdatedNodemailer];
