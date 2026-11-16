use std::borrow::Cow;
use std::fmt;

use serde::Deserialize;
use serde::de::{Deserializer, MapAccess, SeqAccess, Visitor};

#[derive(Clone)]
pub(super) enum Value<'a> {
    Text(Cow<'a, str>),
    Object(Fields<'a>),
    List(Vec<Value<'a>>),
    Flag(bool),
    Null,
}

#[derive(Clone, Default)]
pub(super) struct Fields<'a>(pub Vec<(&'a str, Value<'a>)>);

impl<'a> Fields<'a> {
    pub fn get(&self, name: &str) -> Option<&Value<'a>> {
        self.0
            .iter()
            .find(|(key, _)| *key == name)
            .map(|(_, value)| value)
    }

    pub fn get_mut(&mut self, name: &str) -> Option<&mut Value<'a>> {
        self.0
            .iter_mut()
            .find(|(key, _)| *key == name)
            .map(|(_, value)| value)
    }

    pub fn text(&self, name: &str) -> Option<&str> {
        self.get(name).and_then(Value::text)
    }
}

impl<'a> Value<'a> {
    pub fn text(&self) -> Option<&str> {
        match self {
            Self::Text(text) => Some(text),
            _ => None,
        }
    }

    pub fn object(&self) -> Option<&Fields<'a>> {
        match self {
            Self::Object(fields) => Some(fields),
            _ => None,
        }
    }

    pub fn object_mut(&mut self) -> Option<&mut Fields<'a>> {
        match self {
            Self::Object(fields) => Some(fields),
            _ => None,
        }
    }

    pub fn repeated(&self) -> &[Self] {
        match self {
            Self::List(values) => values,
            _ => std::slice::from_ref(self),
        }
    }

    pub fn repeated_mut(&mut self) -> &mut [Self] {
        match self {
            Self::List(values) => values,
            _ => std::slice::from_mut(self),
        }
    }

    pub fn append(&mut self, item: Self) {
        if let Self::List(values) = self {
            values.push(item);
        } else {
            *self = Self::List(vec![std::mem::replace(self, Self::Null), item]);
        }
    }
}

struct ObjectVisitor;

impl<'de> Visitor<'de> for ObjectVisitor {
    type Value = Fields<'de>;

    fn expecting(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
        output.write_str("an ordered XML object")
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        let mut fields = Vec::with_capacity(map.size_hint().unwrap_or_default());
        while let Some(field) = map.next_entry()? {
            fields.push(field);
        }
        Ok(Fields(fields))
    }
}

impl<'de: 'a, 'a> Deserialize<'de> for Fields<'a> {
    fn deserialize<D: Deserializer<'de>>(source: D) -> Result<Self, D::Error> {
        source.deserialize_map(ObjectVisitor)
    }
}

impl<'de> Deserialize<'de> for Value<'de> {
    fn deserialize<D: Deserializer<'de>>(source: D) -> Result<Self, D::Error> {
        struct ValueVisitor;

        impl<'de> Visitor<'de> for ValueVisitor {
            type Value = Value<'de>;

            fn expecting(&self, output: &mut fmt::Formatter<'_>) -> fmt::Result {
                output.write_str("an XML object, list or scalar")
            }

            fn visit_map<A: MapAccess<'de>>(self, map: A) -> Result<Self::Value, A::Error> {
                ObjectVisitor.visit_map(map).map(Value::Object)
            }

            fn visit_seq<A: SeqAccess<'de>>(
                self,
                mut sequence: A,
            ) -> Result<Self::Value, A::Error> {
                let mut items = Vec::new();
                while let Some(item) = sequence.next_element()? {
                    items.push(item);
                }
                Ok(Value::List(items))
            }

            fn visit_borrowed_str<E: serde::de::Error>(
                self,
                text: &'de str,
            ) -> Result<Self::Value, E> {
                Ok(Value::Text(Cow::Borrowed(text)))
            }

            fn visit_str<E: serde::de::Error>(self, text: &str) -> Result<Self::Value, E> {
                Ok(Value::Text(Cow::Owned(text.into())))
            }

            fn visit_i64<E: serde::de::Error>(self, value: i64) -> Result<Self::Value, E> {
                Ok(Value::Text(Cow::Owned(value.to_string())))
            }

            fn visit_u64<E: serde::de::Error>(self, value: u64) -> Result<Self::Value, E> {
                Ok(Value::Text(Cow::Owned(value.to_string())))
            }

            fn visit_f64<E: serde::de::Error>(self, value: f64) -> Result<Self::Value, E> {
                Ok(Value::Text(Cow::Owned(value.to_string())))
            }

            fn visit_bool<E: serde::de::Error>(self, value: bool) -> Result<Self::Value, E> {
                Ok(Value::Flag(value))
            }

            fn visit_unit<E: serde::de::Error>(self) -> Result<Self::Value, E> {
                Ok(Value::Null)
            }
        }

        source.deserialize_any(ValueVisitor)
    }
}

pub(super) fn document(value: &Fields<'_>, capacity: usize) -> Option<Vec<u8>> {
    let mut output = String::with_capacity(capacity);
    output.push_str("<?xml version=\"1.0\" encoding=\"utf-8\"?>");
    fields(&mut output, value, 0)?;
    output.push('\n');
    Some(output.into_bytes())
}

#[derive(PartialEq, Eq)]
enum Previous {
    None,
    Text,
    Markup,
}

fn fields(output: &mut String, fields: &Fields<'_>, depth: usize) -> Option<Previous> {
    let mut last = Previous::None;
    for (name, value) in &fields.0 {
        match *name {
            "*ATTRS" => {}
            "*TEXT" => {
                escape(output, value.text()?, false);
                last = Previous::Text;
            }
            "*CDATA" | "*COMMENT" => {
                let text = value.text()?;
                indent(output, depth, &last);
                if *name == "*CDATA" {
                    output.push_str("<![CDATA[");
                    output.push_str(&text.replace("]]>", "]]]]><![CDATA[>"));
                    output.push_str("]]>");
                } else {
                    output.push_str("<!--");
                    let mut dash = false;
                    for ch in text.chars() {
                        if ch == '-' && dash {
                            output.push(' ');
                        }
                        output.push(if xml_char(ch) { ch } else { '\u{fffd}' });
                        dash = ch == '-';
                    }
                    if dash {
                        output.push(' ');
                    }
                    output.push_str("-->");
                }
                last = Previous::Markup;
            }
            _ => {
                if !xml_name(name) {
                    return None;
                }
                for item in value.repeated() {
                    if item.text().is_none() && item.object().is_none() {
                        if matches!(value, Value::List(_)) {
                            continue;
                        }
                        return None;
                    }
                    element(output, name, item, depth, &last)?;
                    last = Previous::Markup;
                }
            }
        }
    }
    Some(last)
}

fn element(
    output: &mut String,
    name: &str,
    value: &Value<'_>,
    depth: usize,
    last: &Previous,
) -> Option<()> {
    indent(output, depth, last);
    output.push('<');
    output.push_str(name);
    let object = value.object();
    if let Some(attrs) = object
        .and_then(|value| value.get("*ATTRS"))
        .and_then(Value::object)
    {
        for (attr, value) in &attrs.0 {
            if !xml_name(attr) {
                return None;
            }
            let text = match value {
                Value::Flag(true) => "true",
                _ => match value.text() {
                    Some(text) => text,
                    None => continue,
                },
            };
            output.push(' ');
            output.push_str(attr);
            output.push_str("=\"");
            escape(output, text, true);
            output.push('"');
        }
    }
    let start = output.len();
    output.push('>');
    let last_child = if let Some(object) = object {
        fields(output, object, depth + 2)?
    } else {
        escape(output, value.text()?, false);
        Previous::Text
    };
    if output.len() == start + 1 {
        output.truncate(start);
        output.push_str("/>");
    } else {
        if last_child == Previous::Markup {
            indent(output, depth, &last_child);
        }
        output.push_str("</");
        output.push_str(name);
        output.push('>');
    }
    Some(())
}

fn indent(output: &mut String, depth: usize, last: &Previous) {
    if *last != Previous::Text {
        output.push('\n');
        output.extend(std::iter::repeat_n(' ', depth));
    }
}

fn xml_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    bytes
        .next()
        .is_some_and(|byte| byte.is_ascii_alphabetic() || matches!(byte, b':' | b'_'))
        && bytes
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b':' | b'.' | b'-'))
}

pub(super) fn escape(output: &mut String, text: &str, attribute: bool) {
    let mut start = 0;
    for (index, ch) in text.char_indices() {
        let replacement = match ch {
            '&' if reference_end(&text[index + 1..]).is_none() => "&amp;",
            '<' => "&lt;",
            '"' if attribute => "&quot;",
            '>' if text[..index].ends_with("]]") => "&gt;",
            ch if !xml_char(ch) => "\u{fffd}",
            _ => continue,
        };
        output.push_str(&text[start..index]);
        output.push_str(replacement);
        start = index + ch.len_utf8();
    }
    output.push_str(&text[start..]);
}

fn xml_char(value: char) -> bool {
    matches!(value,'\t'|'\n'|'\r'|'\u{20}'..='\u{d7ff}'|'\u{e000}'..='\u{fffd}'|'\u{10000}'..='\u{10ffff}')
}

fn reference_end(value: &str) -> Option<usize> {
    let end = value.bytes().take(16).position(|byte| byte == b';')?;
    let reference = &value[..end];
    if matches!(reference, "amp" | "lt" | "gt" | "quot" | "apos") {
        return Some(end);
    }
    let numeric = reference.strip_prefix('#')?;
    let number = if let Some(hex) = numeric.strip_prefix('x')
        && hex.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        u32::from_str_radix(hex, 16).ok()?
    } else if numeric.bytes().all(|byte| byte.is_ascii_digit()) {
        numeric.parse().ok()?
    } else {
        return None;
    };
    char::from_u32(number)
        .filter(|&ch| xml_char(ch))
        .map(|_| end)
}
