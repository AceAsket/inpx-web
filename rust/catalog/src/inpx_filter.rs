use std::borrow::Cow;
use std::cmp::Ordering;
use std::str::Chars;
use std::sync::LazyLock;

use inpx_reader::Record;
use regex::Regex;
use serde_json::Value;

use crate::Result;
use crate::fb2_prepare::js_space;

const MAX_BYTES: usize = 8192;
const MAX_TOKENS: usize = 256;
const UNSUPPORTED: &str = "Неподдерживаемое выражение в поле filter файла INPX";

pub(crate) struct Filter(Expr);

impl Filter {
    pub(crate) fn compile(value: Option<&Value>) -> Result<Option<Self>> {
        let source = match value {
            None | Some(Value::Null | Value::Bool(false)) => return Ok(None),
            Some(Value::Number(number)) if number.as_f64() == Some(0.0) => return Ok(None),
            Some(Value::String(text)) if text.is_empty() => return Ok(None),
            Some(Value::String(text)) if text.len() <= MAX_BYTES => text,
            Some(Value::String(_)) => return Err("Поле filter файла INPX превышает 8 КБ".into()),
            _ => return Err(UNSUPPORTED.into()),
        };
        let tokens = tokenize(source)?;
        Ok(Some(Self(Parser::new(&tokens).function()?)))
    }

    pub(crate) fn includes(&self, record: &Record) -> Result<bool> {
        Ok(self.0.evaluate(record)?.truthy())
    }
}

#[derive(Clone)]
enum Token {
    Name(String),
    Literal(Literal),
    Symbol(&'static str),
}

#[derive(Clone)]
enum Literal {
    Undefined,
    Null,
    Bool(bool),
    Number(f64),
    Text(String),
}

enum Expr {
    Literal(Literal),
    Array(Vec<Literal>),
    Field(String),
    Unary(Box<Expr>),
    Binary(Op, Box<Expr>, Box<Expr>),
    Method(Method, Box<Expr>, Option<Box<Expr>>),
}

#[derive(Clone, Copy)]
enum Op {
    Or,
    And,
    Equal,
    NotEqual,
    StrictEqual,
    StrictNotEqual,
    Less,
    LessEqual,
    Greater,
    GreaterEqual,
}

#[derive(Clone, Copy)]
enum Method {
    Includes,
    StartsWith,
    EndsWith,
    Lowercase,
    Uppercase,
    Trim,
    Length,
}

fn tokenize(mut source: &str) -> Result<Vec<Token>> {
    static NUMBER: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^-?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?").unwrap()
    });
    const SYMBOLS: &[&str] = &[
        "!==", "===", "=>", "==", "!=", "<=", ">=", "&&", "||", "(", ")", "[", "]", "{", "}", ".",
        ",", ";", "!", "<", ">",
    ];
    let mut tokens = Vec::new();
    loop {
        source = source.trim_start_matches(js_space);
        if source.is_empty() {
            break;
        }
        if tokens.len() == MAX_TOKENS {
            return Err("Слишком сложное выражение filter INPX".into());
        }
        let first = source.as_bytes()[0];
        let token = if matches!(first, b'\'' | b'"') {
            let mut chars = source[1..].chars();
            let text = string(&mut chars, char::from(first))?;
            source = chars.as_str();
            Token::Literal(Literal::Text(text))
        } else if name_start(first) {
            let length = source
                .bytes()
                .take_while(|byte| name_start(*byte) || byte.is_ascii_digit())
                .count();
            let name = &source[..length];
            source = &source[length..];
            match name {
                "undefined" => Token::Literal(Literal::Undefined),
                "true" => Token::Literal(Literal::Bool(true)),
                "false" => Token::Literal(Literal::Bool(false)),
                "null" => Token::Literal(Literal::Null),
                _ => Token::Name(name.to_owned()),
            }
        } else if let Some(number) = NUMBER.find(source) {
            let value: f64 = number.as_str().parse()?;
            source = &source[number.end()..];
            Token::Literal(Literal::Number(value))
        } else if let Some(&symbol) = SYMBOLS.iter().find(|symbol| source.starts_with(**symbol)) {
            source = &source[symbol.len()..];
            Token::Symbol(symbol)
        } else {
            return Err(UNSUPPORTED.into());
        };
        tokens.push(token);
    }
    Ok(tokens)
}

fn name_start(byte: u8) -> bool {
    byte.is_ascii_alphabetic() || matches!(byte, b'_' | b'$')
}

fn string(chars: &mut Chars<'_>, quote: char) -> Result<String> {
    let mut units = Vec::new();
    while let Some(ch) = chars.next() {
        let ch = match ch {
            ch if ch == quote => return Ok(String::from_utf16(&units)?),
            '\n' | '\r' => return Err(UNSUPPORTED.into()),
            '\\' => match chars.next().ok_or(UNSUPPORTED)? {
                'n' => '\n',
                'r' => '\r',
                't' => '\t',
                'b' => '\u{8}',
                'f' => '\u{c}',
                'v' => '\u{b}',
                '0' if !chars.as_str().starts_with(|ch: char| ch.is_ascii_digit()) => '\0',
                escape @ ('x' | 'u') => {
                    units.push(hex(chars, if escape == 'x' { 2 } else { 4 })?);
                    continue;
                }
                ch if ch.is_ascii_digit() || matches!(ch, '\r' | '\n') => {
                    return Err(UNSUPPORTED.into());
                }
                ch => ch,
            },
            ch => ch,
        };
        units.extend(ch.encode_utf16(&mut [0; 2]).iter().copied());
    }
    Err(UNSUPPORTED.into())
}

fn hex(chars: &mut Chars<'_>, digits: usize) -> Result<u16> {
    let mut value = 0;
    for _ in 0..digits {
        let digit = chars
            .next()
            .and_then(|ch| ch.to_digit(16))
            .ok_or(UNSUPPORTED)?;
        value = value * 16 + digit as u16;
    }
    Ok(value)
}

struct Parser<'a> {
    tokens: &'a [Token],
    cursor: usize,
    record: Option<&'a str>,
}

impl<'a> Parser<'a> {
    fn new(tokens: &'a [Token]) -> Self {
        Self {
            tokens,
            cursor: 0,
            record: None,
        }
    }

    fn function(mut self) -> Result<Expr> {
        let function = self.word("function");
        if function && matches!(self.peek(), Some(Token::Name(_))) {
            self.cursor += 1;
        }
        self.record = if self.eat("(") {
            if self.eat(")") {
                None
            } else {
                let parameter = self.name()?;
                self.expect(")")?;
                Some(parameter)
            }
        } else if !function {
            Some(self.name()?)
        } else {
            return Err(UNSUPPORTED.into());
        };
        if !function {
            self.expect("=>")?;
        }
        let block = self.eat("{");
        if block && !self.word("return") || function && !block {
            return Err(UNSUPPORTED.into());
        }
        let expr = self.expression(1)?;
        if block {
            self.eat(";");
            self.expect("}")?;
        }
        self.eat(";");
        if self.peek().is_some() {
            return Err(UNSUPPORTED.into());
        }
        Ok(expr)
    }

    fn expression(&mut self, minimum: u8) -> Result<Expr> {
        let mut left = self.unary()?;
        while let Some((operator, precedence)) = self.operator() {
            if precedence < minimum {
                break;
            }
            self.cursor += 1;
            let right = self.expression(precedence + 1)?;
            left = Expr::Binary(operator, Box::new(left), Box::new(right));
        }
        Ok(left)
    }

    fn unary(&mut self) -> Result<Expr> {
        if self.eat("!") {
            return Ok(Expr::Unary(Box::new(self.unary()?)));
        }
        let mut value = self.primary()?;
        while self.eat(".") {
            let method = match self.name()? {
                "includes" => Method::Includes,
                "startsWith" => Method::StartsWith,
                "endsWith" => Method::EndsWith,
                "toLowerCase" => Method::Lowercase,
                "toUpperCase" => Method::Uppercase,
                "trim" => Method::Trim,
                "length" => Method::Length,
                _ => return Err(UNSUPPORTED.into()),
            };
            let argument = match method {
                Method::Length => None,
                Method::Includes | Method::StartsWith | Method::EndsWith => {
                    self.expect("(")?;
                    let argument = self.expression(1)?;
                    self.expect(")")?;
                    Some(Box::new(argument))
                }
                _ => {
                    self.expect("(")?;
                    self.expect(")")?;
                    None
                }
            };
            value = Expr::Method(method, Box::new(value), argument);
        }
        Ok(value)
    }

    fn primary(&mut self) -> Result<Expr> {
        match self.take().ok_or(UNSUPPORTED)? {
            Token::Literal(value) => Ok(Expr::Literal(value.clone())),
            Token::Name(name) if Some(name.as_str()) == self.record => {
                let field = if self.eat(".") {
                    self.name()?
                } else {
                    self.expect("[")?;
                    let Some(Token::Literal(Literal::Text(name))) = self.take() else {
                        return Err(UNSUPPORTED.into());
                    };
                    self.expect("]")?;
                    name
                };
                Ok(Expr::Field(field.to_owned()))
            }
            Token::Symbol("(") => {
                let value = self.expression(1)?;
                self.expect(")")?;
                Ok(value)
            }
            Token::Symbol("[") => {
                let mut values = Vec::new();
                while !self.eat("]") {
                    let Some(Token::Literal(value)) = self.take() else {
                        return Err(UNSUPPORTED.into());
                    };
                    values.push(value.clone());
                    if self.eat("]") {
                        break;
                    }
                    self.expect(",")?;
                }
                Ok(Expr::Array(values))
            }
            _ => Err(UNSUPPORTED.into()),
        }
    }

    fn operator(&self) -> Option<(Op, u8)> {
        let Token::Symbol(symbol) = self.peek()? else {
            return None;
        };
        Some(match *symbol {
            "||" => (Op::Or, 1),
            "&&" => (Op::And, 2),
            "==" => (Op::Equal, 3),
            "!=" => (Op::NotEqual, 3),
            "===" => (Op::StrictEqual, 3),
            "!==" => (Op::StrictNotEqual, 3),
            "<" => (Op::Less, 4),
            "<=" => (Op::LessEqual, 4),
            ">" => (Op::Greater, 4),
            ">=" => (Op::GreaterEqual, 4),
            _ => return None,
        })
    }

    fn name(&mut self) -> Result<&'a str> {
        match self.take() {
            Some(Token::Name(name)) => Ok(name),
            _ => Err(UNSUPPORTED.into()),
        }
    }

    fn expect(&mut self, symbol: &str) -> Result<()> {
        if self.eat(symbol) {
            Ok(())
        } else {
            Err(UNSUPPORTED.into())
        }
    }

    fn eat(&mut self, expected: &str) -> bool {
        let matched = matches!(self.peek(), Some(Token::Symbol(symbol)) if *symbol == expected);
        self.cursor += usize::from(matched);
        matched
    }

    fn word(&mut self, expected: &str) -> bool {
        let matched = matches!(self.peek(), Some(Token::Name(name)) if name == expected);
        self.cursor += usize::from(matched);
        matched
    }

    fn peek(&self) -> Option<&'a Token> {
        self.tokens.get(self.cursor)
    }

    fn take(&mut self) -> Option<&'a Token> {
        let token = self.peek()?;
        self.cursor += 1;
        Some(token)
    }
}

enum Item<'a> {
    Undefined,
    Null,
    Bool(bool),
    Number(f64),
    Text(Cow<'a, str>),
    Array(&'a [Literal]),
}

impl Expr {
    fn evaluate<'a>(&'a self, record: &'a Record) -> Result<Item<'a>> {
        Ok(match self {
            Self::Literal(value) => value.item(),
            Self::Array(values) => Item::Array(values),
            Self::Field(field) => match record.get(field) {
                Some(Value::Null) => Item::Null,
                Some(Value::Bool(value)) => Item::Bool(*value),
                Some(Value::Number(value)) => Item::Number(value.as_f64().unwrap_or(f64::NAN)),
                Some(Value::String(value)) => Item::Text(Cow::Borrowed(value)),
                _ => Item::Undefined,
            },
            Self::Unary(value) => Item::Bool(!value.evaluate(record)?.truthy()),
            Self::Binary(operator, left, right) => {
                let left = left.evaluate(record)?;
                match operator {
                    Op::Or if left.truthy() => left,
                    Op::And if !left.truthy() => left,
                    Op::Or | Op::And => right.evaluate(record)?,
                    _ => Item::Bool(operator.compare(&left, &right.evaluate(record)?)),
                }
            }
            Self::Method(method, target, argument) => method.call(
                target.evaluate(record)?,
                argument
                    .as_ref()
                    .map(|argument| argument.evaluate(record))
                    .transpose()?,
            )?,
        })
    }
}

impl Literal {
    fn item(&self) -> Item<'_> {
        match self {
            Self::Undefined => Item::Undefined,
            Self::Null => Item::Null,
            Self::Bool(value) => Item::Bool(*value),
            Self::Number(value) => Item::Number(*value),
            Self::Text(value) => Item::Text(Cow::Borrowed(value)),
        }
    }
}

impl Op {
    fn compare(self, left: &Item<'_>, right: &Item<'_>) -> bool {
        match self {
            Self::Equal => left.loose(right),
            Self::NotEqual => !left.loose(right),
            Self::StrictEqual => left.strict(right),
            Self::StrictNotEqual => !left.strict(right),
            _ => {
                let order = match (left, right) {
                    (Item::Text(left), Item::Text(right)) => {
                        Some(left.encode_utf16().cmp(right.encode_utf16()))
                    }
                    _ => left.number().partial_cmp(&right.number()),
                };
                matches!(
                    (self, order),
                    (Self::Less | Self::LessEqual, Some(Ordering::Less))
                        | (Self::LessEqual | Self::GreaterEqual, Some(Ordering::Equal))
                        | (Self::Greater | Self::GreaterEqual, Some(Ordering::Greater))
                )
            }
        }
    }
}

impl Method {
    fn call<'a>(self, target: Item<'a>, argument: Option<Item<'a>>) -> Result<Item<'a>> {
        let value = match target {
            Item::Array(values) => {
                return Ok(match self {
                    Self::Length => Item::Number(values.len() as f64),
                    Self::Includes => Item::Bool(values.iter().any(|value| {
                        value
                            .item()
                            .strict(argument.as_ref().expect("includes argument"))
                    })),
                    _ => return Err(UNSUPPORTED.into()),
                });
            }
            Item::Text(value) => value,
            _ => {
                return Err("Строковая операция filter INPX получила значение другого типа".into());
            }
        };
        Ok(match self {
            Self::Length => Item::Number(value.encode_utf16().count() as f64),
            Self::Lowercase => Item::Text(Cow::Owned(value.to_lowercase())),
            Self::Uppercase => Item::Text(Cow::Owned(value.to_uppercase())),
            Self::Trim => Item::Text(match value {
                Cow::Borrowed(value) => Cow::Borrowed(value.trim_matches(js_space)),
                Cow::Owned(value) => Cow::Owned(value.trim_matches(js_space).to_owned()),
            }),
            method => {
                let needle = argument.expect("string method argument").into_text();
                Item::Bool(match method {
                    Self::Includes => value.contains(needle.as_ref()),
                    Self::StartsWith => value.starts_with(needle.as_ref()),
                    Self::EndsWith => value.ends_with(needle.as_ref()),
                    _ => unreachable!(),
                })
            }
        })
    }
}

impl<'a> Item<'a> {
    fn truthy(&self) -> bool {
        match self {
            Self::Undefined | Self::Null => false,
            Self::Bool(value) => *value,
            Self::Number(value) => *value != 0.0 && !value.is_nan(),
            Self::Text(value) => !value.is_empty(),
            Self::Array(_) => true,
        }
    }

    fn strict(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Undefined, Self::Undefined) | (Self::Null, Self::Null) => true,
            (Self::Bool(left), Self::Bool(right)) => left == right,
            (Self::Number(left), Self::Number(right)) => left == right,
            (Self::Text(left), Self::Text(right)) => left == right,
            _ => false,
        }
    }

    fn loose(&self, other: &Self) -> bool {
        if self.strict(other) {
            return true;
        }
        match (self, other) {
            (Self::Undefined | Self::Null, Self::Undefined | Self::Null) => true,
            (Self::Undefined | Self::Null, _) | (_, Self::Undefined | Self::Null) => false,
            (Self::Array(_), Self::Array(_)) => false,
            (Self::Array(values), _) => Item::Text(Cow::Owned(array_text(values))).loose(other),
            (_, Self::Array(values)) => self.loose(&Item::Text(Cow::Owned(array_text(values)))),
            (Self::Bool(_), _)
            | (_, Self::Bool(_))
            | (Self::Text(_), Self::Number(_))
            | (Self::Number(_), Self::Text(_)) => self.number() == other.number(),
            _ => false,
        }
    }

    fn number(&self) -> f64 {
        match self {
            Self::Undefined => f64::NAN,
            Self::Null => 0.0,
            Self::Bool(value) => {
                if *value {
                    1.0
                } else {
                    0.0
                }
            }
            Self::Number(value) => *value,
            Self::Text(value) => numeric(value),
            Self::Array(values) => numeric(&array_text(values)),
        }
    }

    fn into_text(self) -> Cow<'a, str> {
        match self {
            Self::Undefined => Cow::Borrowed("undefined"),
            Self::Null => Cow::Borrowed("null"),
            Self::Bool(true) => Cow::Borrowed("true"),
            Self::Bool(false) => Cow::Borrowed("false"),
            Self::Number(value) => Cow::Owned(if value == 0.0 {
                "0".into()
            } else {
                value.to_string()
            }),
            Self::Text(value) => value,
            Self::Array(values) => Cow::Owned(array_text(values)),
        }
    }
}

fn array_text(values: &[Literal]) -> String {
    values
        .iter()
        .map(|value| match value {
            Literal::Null | Literal::Undefined => Cow::Borrowed(""),
            value => value.item().into_text(),
        })
        .collect::<Vec<_>>()
        .join(",")
}

fn numeric(text: &str) -> f64 {
    let text = text.trim_matches(js_space);
    if text.is_empty() {
        return 0.0;
    }
    if let Some(base) = text.as_bytes().get(..2) {
        let radix = match base {
            b"0x" | b"0X" => 16,
            b"0b" | b"0B" => 2,
            b"0o" | b"0O" => 8,
            _ => 0,
        };
        if radix != 0 {
            return u64::from_str_radix(&text[2..], radix).map_or(f64::NAN, |value| value as f64);
        }
    }
    match text {
        "Infinity" | "+Infinity" => f64::INFINITY,
        "-Infinity" => f64::NEG_INFINITY,
        text if text
            .bytes()
            .all(|byte| byte.is_ascii_digit() || b".+-eE".contains(&byte)) =>
        {
            text.parse().unwrap_or(f64::NAN)
        }
        _ => f64::NAN,
    }
}
