pub(crate) fn escape(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    append_text(&mut output, value, false);
    output
}

pub(crate) fn sanitize(mut value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut suppressed: Option<&'static str> = None;
    while let Some(offset) = value.find('<') {
        if suppressed.is_none() {
            append_text(&mut output, &value[..offset], true);
        }
        let rest = &value[offset + 1..];
        if let Some((consumed, name, closing)) = tag(rest) {
            if let Some(target) = suppressed {
                if closing && name.eq_ignore_ascii_case(target) {
                    suppressed = None;
                }
            } else if !closing && name.eq_ignore_ascii_case("script") {
                suppressed = Some("script");
            } else if !closing && name.eq_ignore_ascii_case("style") {
                suppressed = Some("style");
            } else if allowed(name) {
                output.push('<');
                if closing {
                    output.push('/');
                }
                output.push_str(&name.to_ascii_lowercase());
                output.push('>');
            }
            value = &rest[consumed..];
        } else {
            if suppressed.is_none() {
                output.push_str("&lt;");
            }
            value = rest;
        }
    }
    if suppressed.is_none() {
        append_text(&mut output, value, true);
    }
    output
}

fn allowed(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "p" | "br"
            | "b"
            | "i"
            | "u"
            | "em"
            | "strong"
            | "h1"
            | "h2"
            | "h3"
            | "h4"
            | "h5"
            | "h6"
            | "sub"
            | "sup"
            | "ul"
            | "ol"
            | "li"
            | "blockquote"
            | "div"
            | "span"
    )
}

fn tag(value: &str) -> Option<(usize, &str, bool)> {
    let end = value.find(['<', '>'])?;
    if value.as_bytes()[end] != b'>' {
        return None;
    }
    let mut inner = &value[..end];
    let closing = inner.starts_with('/');
    if closing {
        inner = &inner[1..];
    }
    if !inner.as_bytes().first()?.is_ascii_alphabetic() {
        return None;
    }
    let length = inner
        .bytes()
        .take_while(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b':' | b'.' | b'-')
        })
        .count();
    let tail = &inner[length..];
    if !tail.is_empty() && tail != "/" && !tail.starts_with(char::is_whitespace) {
        return None;
    }
    Some((end + 1, &inner[..length], closing))
}

fn append_text(output: &mut String, mut input: &str, entities: bool) {
    while let Some(offset) = input.find(['&', '<', '>', '"', '\'']) {
        output.push_str(&input[..offset]);
        input = &input[offset..];
        if entities
            && input.starts_with('&')
            && let Some(reference) = reference(input)
        {
            output.push_str(reference);
            input = &input[reference.len()..];
            continue;
        }
        output.push_str(match input.as_bytes()[0] {
            b'&' => "&amp;",
            b'<' => "&lt;",
            b'>' => "&gt;",
            b'"' => "&quot;",
            _ => "&#39;",
        });
        input = &input[1..];
    }
    output.push_str(input);
}

fn reference(value: &str) -> Option<&str> {
    let end = value
        .as_bytes()
        .iter()
        .take(34)
        .position(|byte| *byte == b';')?;
    let token = &value.as_bytes()[1..end];
    let valid = match token {
        [b'#', b'x' | b'X', digits @ ..] => {
            (1..=6).contains(&digits.len()) && digits.iter().all(u8::is_ascii_hexdigit)
        }
        [b'#', digits @ ..] => {
            (1..=7).contains(&digits.len()) && digits.iter().all(u8::is_ascii_digit)
        }
        [first, tail @ ..] => {
            (1..=31).contains(&tail.len())
                && first.is_ascii_alphabetic()
                && tail.iter().all(u8::is_ascii_alphanumeric)
        }
        [] => false,
    };
    valid.then_some(&value[..end + 1])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_strips_script_and_style_inner_text() {
        assert_eq!(
            sanitize("<p>Hello</p><script>alert(1)</script><p>World</p>"),
            "<p>Hello</p><p>World</p>"
        );
        assert_eq!(
            sanitize("<STYLE type=\"text/css\">body { display: none; }</STYLE><b>Text</b>"),
            "<b>Text</b>"
        );
        assert_eq!(
            sanitize("<script>if (a < b && c > d) { alert('</style>'); }</script>Safe"),
            "Safe"
        );
        assert_eq!(
            sanitize("<style>p { content: '</script>'; }</style>Safe"),
            "Safe"
        );
        assert_eq!(sanitize("<script>unclosed payload"), "");
        assert_eq!(
            sanitize(
                "<P style=\"color:red\">Описание &nbsp;<b>тест</b></P><svg><title>Другой текст</title></svg>&lt;p&gt;"
            ),
            "<p>Описание &nbsp;<b>тест</b></p>Другой текст&lt;p&gt;"
        );
    }
}
