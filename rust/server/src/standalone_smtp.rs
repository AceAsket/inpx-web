use std::path::Path;
use std::time::Duration;

use base64::{Engine, engine::general_purpose::STANDARD};
use inpx_catalog::Result;
use mail_send::{
    Credentials, SmtpClient, SmtpClientBuilder,
    smtp::{AssertReply, message::Parameters},
};
use percent_encoding::{NON_ALPHANUMERIC, utf8_percent_encode};
use serde_json::Value;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use super::delivery::{boolean, setting};

const TIMEOUT: Duration = Duration::from_secs(120);

pub(super) struct Mail {
    host: String,
    port: u16,
    secure: bool,
    enabled: bool,
    user: String,
    password: String,
    from: String,
    to: String,
}

impl Mail {
    pub(super) fn new(config: &Value) -> Self {
        let host = setting(config, "SMTP_HOST", "smtpHost");
        let user = setting(config, "SMTP_USER", "smtpUser");
        let sender = setting(config, "EMAIL_FROM", "emailFrom");
        let enabled = boolean(
            config,
            "INPX_EMAIL_SHARE_ENABLED",
            "emailShareEnabled",
            !host.is_empty(),
        );
        Self {
            enabled: enabled && !host.is_empty(),
            host,
            port: setting(config, "SMTP_PORT", "smtpPort")
                .parse::<u16>()
                .ok()
                .filter(|p| *p > 0)
                .unwrap_or(587),
            secure: boolean(config, "SMTP_SECURE", "smtpSecure", false),
            from: if !sender.is_empty() {
                sender
            } else if !user.is_empty() {
                user.clone()
            } else {
                "inpx-web@localhost".into()
            },
            user,
            password: setting(config, "SMTP_PASS", "smtpPass"),
            to: setting(config, "EMAIL_TO", "emailTo"),
        }
    }

    pub(super) fn destination<'a>(&'a self, profile: &'a Value) -> Option<&'a str> {
        let recipient = profile["emailTo"].as_str().unwrap_or_default().trim();
        let recipient = if recipient.is_empty() {
            &self.to
        } else {
            recipient
        };
        (self.enabled && !recipient.is_empty()).then_some(recipient)
    }

    pub(super) async fn send(
        &self,
        to: &str,
        author: &str,
        title: &str,
        filename: &str,
        file: &Path,
    ) -> Result<()> {
        let from = address(&self.from)?;
        let recipients = to.split(',').map(address).collect::<Result<Vec<_>>>()?;
        let subject = if author.is_empty() {
            title.to_owned()
        } else {
            format!("{author} - {title}")
        };
        let time = httpdate::fmt_http_date(std::time::SystemTime::now());
        let boundary = format!("inpx-{}", super::delivery::random_id()?);
        let message = Message {
            from,
            recipients,
            filename,
            boundary,
            date: time,
            subject: format!("Книга: {subject}"),
            body: format!("Во вложении книга \"{title}\"."),
        };
        let result = tokio::time::timeout(Duration::from_secs(270), async {
            message.deliver(self.connect().await?, file).await
        })
        .await;
        match result {
            Ok(Ok(())) => Ok(()),
            Ok(Err(mail_send::Error::UnexpectedReply(reply))) => {
                Err(format!("Email не отправлен: SMTP {}", reply.code()).into())
            }
            Ok(Err(mail_send::Error::AuthenticationFailed(reply))) => {
                Err(format!("Email не отправлен: ошибка входа SMTP {}", reply.code()).into())
            }
            Ok(Err(_)) => Err("Email не отправлен: проверьте подключение и настройки SMTP".into()),
            Err(_) => Err("Email не отправлен: истекло время ожидания SMTP".into()),
        }
    }

    pub(super) async fn verify(&self) -> Result<Value> {
        if self.host.is_empty() {
            return Err("SMTP host не указан".into());
        }
        let client = tokio::time::timeout(Duration::from_secs(15), self.connect())
            .await
            .map_err(|_| "Истекло время подключения к SMTP")?
            .map_err(
                |_| "Не удалось подключиться к SMTP. Проверьте адрес, TLS и учётные данные.",
            )?;
        let _ = tokio::time::timeout(Duration::from_secs(2), client.quit()).await;
        Ok(serde_json::json!({"success":true,"message":"SMTP подключение проверено"}))
    }

    async fn connect(&self) -> mail_send::Result<SmtpClient<Box<dyn SmtpIo>>> {
        let mut builder =
            SmtpClientBuilder::new(self.host.trim_matches(['[', ']']).to_owned(), self.port)
                .map_err(|message| mail_send::Error::Io(std::io::Error::other(message)))?
                .timeout(TIMEOUT);
        if self.host.contains(':') {
            builder.addr = format!("[{}]:{}", self.host.trim_matches(['[', ']']), self.port);
        }
        if !self.user.is_empty() {
            builder.credentials = Some(Credentials::Plain {
                username: self.user.clone(),
                secret: self.password.clone(),
            });
        }
        if self.secure {
            return Ok(boxed(builder.connect().await?));
        }
        let builder = builder.say_ehlo(false);
        let mut connection = builder.connect_plain().await?;
        let capabilities = connection.ehlo(&builder.local_host).await?;
        if capabilities.has_capability(smtp_proto::EXT_START_TLS) {
            let mut tls = connection
                .start_tls(&builder.tls_connector, &builder.tls_hostname)
                .await?;
            let capabilities = tls.ehlo(&builder.local_host).await?;
            if let Some(credentials) = &builder.credentials {
                tls.authenticate(credentials, &capabilities).await?;
            }
            Ok(boxed(tls))
        } else {
            if let Some(credentials) = &builder.credentials {
                connection.authenticate(credentials, &capabilities).await?;
            }
            Ok(boxed(connection))
        }
    }
}

trait SmtpIo: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> SmtpIo for T {}

fn boxed<T: SmtpIo + 'static>(client: SmtpClient<T>) -> SmtpClient<Box<dyn SmtpIo>> {
    SmtpClient {
        stream: Box::new(client.stream),
        timeout: client.timeout,
    }
}

struct Message<'a> {
    from: &'a str,
    recipients: Vec<&'a str>,
    filename: &'a str,
    boundary: String,
    date: String,
    subject: String,
    body: String,
}

impl Message<'_> {
    async fn deliver<T: AsyncRead + AsyncWrite + Unpin>(
        &self,
        mut client: SmtpClient<T>,
        path: &Path,
    ) -> mail_send::Result<()> {
        let mut file = tokio::fs::File::open(path).await?;
        let params = Parameters::default();
        client.mail_from(self.from, &params).await?;
        for recipient in &self.recipients {
            client.rcpt_to(recipient, &params).await?;
        }
        client.cmd(b"DATA\r\n").await?.assert_code(354)?;
        let subject = encoded_subject(&self.subject);
        let filename = utf8_percent_encode(self.filename, NON_ALPHANUMERIC);
        let boundary = &self.boundary;
        let to = self.recipients.join(",\r\n ");
        let date = self.date.trim_end_matches("GMT");
        let head = format!(
            "From: {}\r\nTo: {to}\r\nDate: {date}+0000\r\nSubject: {subject}\r\n\
             Message-ID: <{boundary}@inpx.local>\r\nMIME-Version: 1.0\r\n\
             Content-Type: multipart/mixed; boundary=\"{boundary}\"\r\n\r\n\
             --{boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n",
            self.from,
        );
        client.stream.write_all(head.as_bytes()).await?;
        let mut encoded = Vec::new();
        encode_lines(self.body.as_bytes(), &mut encoded);
        client.stream.write_all(&encoded).await?;
        let part = format!(
            "\r\n--{boundary}\r\nContent-Type: application/octet-stream\r\n\
            Content-Disposition: attachment;\r\n filename*=UTF-8''{filename}\r\nContent-Transfer-Encoding: base64\r\n\r\n"
        );
        client.stream.write_all(part.as_bytes()).await?;
        let mut block = [0; 57 * 128];
        loop {
            let mut used = 0;
            while used < block.len() {
                let size = file.read(&mut block[used..]).await?;
                if size == 0 {
                    break;
                }
                used += size;
            }
            if used == 0 {
                break;
            }
            encoded.clear();
            encode_lines(&block[..used], &mut encoded);
            client.stream.write_all(&encoded).await?;
        }
        // The assembled body contains only MIME headers, boundaries and Base64.
        let end = format!("\r\n--{boundary}--\r\n.\r\n");
        client.stream.write_all(end.as_bytes()).await?;
        client.stream.flush().await?;
        client.read().await?.assert_positive_completion()?;
        // A successful DATA is final even if QUIT fails.
        let _ = tokio::time::timeout(Duration::from_secs(2), client.quit()).await;
        Ok(())
    }
}

fn address(input: &str) -> Result<&str> {
    let input = input.trim();
    let value = input
        .rsplit_once('<')
        .and_then(|(_, address)| address.strip_suffix('>'))
        .unwrap_or(input)
        .trim();
    let (local, domain) = value.split_once('@').ok_or("Некорректный адрес email")?;
    if local.is_empty()
        || domain.is_empty()
        || value.len() > 254
        || !local
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b".!#$%&'*+-/=?^_`{|}~".contains(&byte))
        || !domain
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b".-".contains(&byte))
    {
        return Err("Некорректный адрес email".into());
    }
    Ok(value)
}

fn encode_lines(body: &[u8], out: &mut Vec<u8>) {
    let mut line = [0; 76];
    for chunk in body.chunks(57) {
        let length = STANDARD
            .encode_slice(chunk, &mut line)
            .expect("base64 line buffer");
        out.extend_from_slice(&line[..length]);
        out.extend_from_slice(b"\r\n");
    }
}

fn encoded_subject(mut subject: &str) -> String {
    let mut words = Vec::new();
    while !subject.is_empty() {
        let index = subject.floor_char_boundary(subject.len().min(42));
        let (part, rest) = subject.split_at(index);
        words.push(format!("=?UTF-8?B?{}?=", STANDARD.encode(part)));
        subject = rest;
    }
    words.join("\r\n ")
}
