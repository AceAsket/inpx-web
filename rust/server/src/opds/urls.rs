use std::borrow::Cow;

type Query<'a> = Vec<(Cow<'a, str>, Cow<'a, str>)>;

pub(super) fn component(value: &str) -> String {
    let mut result = String::with_capacity(value.len());
    encode(&mut result, value, false);
    result
}

fn encode(output: &mut String, value: &str, form: bool) {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    for byte in value.bytes() {
        match byte {
            b' ' if form => output.push('+'),
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'*' => {
                output.push(byte as char)
            }
            b'~' | b'!' | b'\'' | b'(' | b')' if !form => output.push(byte as char),
            _ => {
                output.push('%');
                output.push(HEX[(byte >> 4) as usize] as char);
                output.push(HEX[(byte & 15) as usize] as char);
            }
        }
    }
}

fn decode(value: &str) -> Cow<'_, str> {
    fn hex(byte: u8) -> Option<u8> {
        match byte {
            b'0'..=b'9' => Some(byte - b'0'),
            b'a'..=b'f' => Some(byte - b'a' + 10),
            b'A'..=b'F' => Some(byte - b'A' + 10),
            _ => None,
        }
    }
    if !value.contains(['%', '+']) {
        return Cow::Borrowed(value);
    }
    let bytes = value.as_bytes();
    let mut result = Vec::with_capacity(bytes.len());
    let mut offset = 0;
    while offset < bytes.len() {
        let byte = bytes[offset];
        if byte == b'%'
            && let Some([high, low]) = bytes.get(offset + 1..offset + 3)
            && let (Some(high), Some(low)) = (hex(*high), hex(*low))
        {
            result.push(high * 16 + low);
            offset += 3;
        } else {
            result.push(if byte == b'+' { b' ' } else { byte });
            offset += 1;
        }
    }
    Cow::Owned(
        String::from_utf8(result)
            .unwrap_or_else(|error| String::from_utf8_lossy(error.as_bytes()).into_owned()),
    )
}

fn pairs(query: &str) -> Query<'_> {
    query
        .split('&')
        .filter(|item| !item.is_empty())
        .map(|item| {
            let (name, value) = item.split_once('=').unwrap_or((item, ""));
            (decode(name), decode(value))
        })
        .collect()
}

pub(super) fn scoped(href: &str, scope: &str, parameter: Option<(&str, &str)>) -> String {
    let mut parts = href.split('?');
    let path = parts.next().unwrap_or_default();
    let mut params = pairs(parts.next().unwrap_or_default());
    if !scope.is_empty() && !params.iter().any(|(key, _)| key == "user") {
        params.push(("user".into(), scope.into()));
    }
    if let Some((name, value)) = parameter {
        let mut set = false;
        params.retain_mut(|(key, old)| {
            if key != name {
                return true;
            }
            if set || value.is_empty() {
                return false;
            }
            *old = Cow::Borrowed(value);
            set = true;
            true
        });
        if !set && !value.is_empty() {
            params.push((name.into(), value.into()));
        }
    }
    let mut output = path.to_owned();
    for (index, (name, value)) in params.iter().enumerate() {
        output.push(if index == 0 { '?' } else { '&' });
        encode(&mut output, name, true);
        output.push('=');
        encode(&mut output, value, true);
    }
    output
}

pub(super) fn same_link(left: &str, right: &str) -> bool {
    if left == right {
        return true;
    }
    fn split(href: &str) -> (&str, Query<'_>) {
        let href = href.strip_prefix("http://opds.invalid").unwrap_or(href);
        let (path, query) = href.split_once('?').unwrap_or((href, ""));
        let mut params = pairs(query);
        params.sort_by(|(left, _), (right, _)| left.encode_utf16().cmp(right.encode_utf16()));
        (path, params)
    }
    split(left) == split(right)
}

pub(super) fn scope_catalog_link(href: &str, root: &str, scope: &str) -> Option<String> {
    if scope.is_empty() {
        return None;
    }
    let mut parts = href.split('?');
    let path = parts.next().unwrap_or_default();
    if path
        .strip_prefix(root)
        .is_none_or(|rest| !rest.is_empty() && !rest.starts_with('/'))
    {
        return None;
    }
    if parts.next().is_some_and(|query| {
        query.split('&').any(|pair| {
            let name = pair.split('=').next().unwrap_or_default();
            name == "user" || name.contains('%') && decode(name) == "user"
        })
    }) {
        return None;
    }
    Some(scoped(href, scope, None))
}
