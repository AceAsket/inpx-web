use std::io;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

use inpx_catalog::Result;
use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use url::{Host, Url};

pub(crate) fn is_cloud_metadata_host(host: &str) -> bool {
    let host = host.trim().trim_end_matches('.').to_ascii_lowercase();
    matches!(
        host.as_str(),
        "metadata.google.internal"
            | "metadata.goog"
            | "metadata.azure.internal"
            | "metadata.tencentyun.com"
            | "metadata.aliyun.com"
            | "instance-data"
    )
}

fn is_nat64_well_known(v6: Ipv6Addr) -> bool {
    let seg = v6.segments();
    seg[0] == 0x0064 && seg[1] == 0xff9b && seg[2] == 0 && seg[3] == 0 && seg[4] == 0 && seg[5] == 0
}

fn is_nat64_local(v6: Ipv6Addr) -> bool {
    let seg = v6.segments();
    seg[0] == 0x0064 && seg[1] == 0xff9b && seg[2] == 0x0001
}

fn embedded_v4_for_metadata(v6: Ipv6Addr) -> Option<Ipv4Addr> {
    let seg = v6.segments();
    let octets = v6.octets();
    if is_nat64_well_known(v6) || is_nat64_local(v6) {
        return Some(Ipv4Addr::new(
            octets[12], octets[13], octets[14], octets[15],
        ));
    }
    // 6to4 2002::/16 embeds IPv4 in octets 2..6.
    if seg[0] == 0x2002 {
        return Some(Ipv4Addr::new(octets[2], octets[3], octets[4], octets[5]));
    }
    // Teredo 2001::/32 embeds XOR-obfuscated IPv4 in octets 12..16.
    if seg[0] == 0x2001 && seg[1] == 0x0000 {
        return Some(Ipv4Addr::new(
            octets[12] ^ 0xff,
            octets[13] ^ 0xff,
            octets[14] ^ 0xff,
            octets[15] ^ 0xff,
        ));
    }
    // Deprecated IPv4-compatible ::/96 (excluding :: and ::1).
    if seg[0..6] == [0; 6] && !v6.is_unspecified() && !v6.is_loopback() {
        return Some(Ipv4Addr::new(
            octets[12], octets[13], octets[14], octets[15],
        ));
    }
    None
}

pub(crate) fn is_cloud_metadata_ip(ip: IpAddr) -> bool {
    match ip.to_canonical() {
        IpAddr::V4(v4) => v4.is_link_local() || v4 == Ipv4Addr::new(100, 100, 100, 200),
        IpAddr::V6(v6) => {
            v6.is_unicast_link_local()
                || v6 == Ipv6Addr::new(0xfd00, 0x0ec2, 0, 0, 0, 0, 0, 0x0254)
                || embedded_v4_for_metadata(v6)
                    .is_some_and(|v4| is_cloud_metadata_ip(IpAddr::V4(v4)))
        }
    }
}

pub(crate) fn is_public_ip(ip: IpAddr) -> bool {
    match ip.to_canonical() {
        IpAddr::V4(v4) => {
            let [a, b, c, _] = v4.octets();
            !v4.is_private()
                && !v4.is_loopback()
                && !v4.is_link_local()
                && !v4.is_broadcast()
                && !v4.is_documentation()
                && !v4.is_unspecified()
                && !v4.is_multicast()
                // 0.0.0.0/8, CGNAT 100.64.0.0/10, 192.0.0.0/24, 198.18.0.0/15, 240.0.0.0/4
                && a != 0
                && !(a == 100 && (64..=127).contains(&b))
                && !(a == 192 && b == 0 && c == 0)
                && !(a == 198 && (b == 18 || b == 19))
                && a < 240
        }
        IpAddr::V6(v6) => {
            let seg = v6.segments();
            !v6.is_loopback()
                && !v6.is_unspecified()
                && !v6.is_multicast()
                && !v6.is_unicast_link_local()
                && !v6.is_unique_local()
                // NAT64 well-known 64:ff9b::/96 and local-use 64:ff9b:1::/48
                && !is_nat64_well_known(v6)
                && !is_nat64_local(v6)
                // Discard-only 100::/64
                && !(seg[0] == 0x0100 && seg[1] == 0 && seg[2] == 0 && seg[3] == 0)
                // Teredo 2001::/32
                && !(seg[0] == 0x2001 && seg[1] == 0x0000)
                // 6to4 2002::/16
                && seg[0] != 0x2002
                // Deprecated IPv4-compatible ::/96
                && seg[0..6] != [0; 6]
                // Documentation 2001:db8::/32
                && !(seg[0] == 0x2001 && seg[1] == 0x0db8)
                // Site-local deprecated fec0::/10
                && (seg[0] & 0xffc0) != 0xfec0
        }
    }
}

pub(crate) fn is_non_canonical_numeric_ip(host: &str) -> bool {
    let clean = host.trim().trim_matches(['[', ']']);
    if clean.is_empty() || clean.parse::<IpAddr>().is_ok() {
        return false;
    }
    let trimmed = clean.trim_end_matches('.');
    if trimmed.is_empty() {
        return false;
    }
    let parts: Vec<&str> = trimmed.split('.').collect();
    if parts.is_empty() || parts.len() > 4 {
        return false;
    }
    parts.iter().all(|part| {
        if part.is_empty() {
            return false;
        }
        if let Some(hex) = part.strip_prefix("0x").or_else(|| part.strip_prefix("0X")) {
            !hex.is_empty() && hex.bytes().all(|b| b.is_ascii_hexdigit())
        } else {
            part.bytes().all(|b| b.is_ascii_digit())
        }
    })
}

fn check_domain_metadata_or_numeric(domain: &str, label: &str) -> Result<()> {
    let clean = domain.trim().trim_matches(['[', ']']);
    if is_cloud_metadata_host(clean) {
        return Err(format!("Адрес {label} указывает на служебную сеть метаданных").into());
    }
    let ip_candidate = clean.split_once('%').map_or(clean, |(prefix, _)| prefix);
    if let Ok(ip) = ip_candidate.parse::<IpAddr>()
        && is_cloud_metadata_ip(ip)
    {
        return Err(format!("Адрес {label} указывает на служебную сеть метаданных").into());
    }
    if is_non_canonical_numeric_ip(clean) {
        return Err(format!("Некорректный числовой IP-адрес {label}").into());
    }
    Ok(())
}

pub(crate) fn validate_integration_url(url: &Url, label: &str) -> Result<()> {
    let Some(host) = url.host() else {
        return Err(format!("Некорректный адрес {label}").into());
    };
    match host {
        Host::Ipv4(v4) if is_cloud_metadata_ip(IpAddr::V4(v4)) => {
            return Err(format!("Адрес {label} указывает на служебную сеть метаданных").into());
        }
        Host::Ipv6(v6) if is_cloud_metadata_ip(IpAddr::V6(v6)) => {
            return Err(format!("Адрес {label} указывает на служебную сеть метаданных").into());
        }
        Host::Domain(domain) => {
            check_domain_metadata_or_numeric(domain, label)?;
        }
        _ => {}
    }
    Ok(())
}

pub(crate) fn validate_smtp_host(host: &str) -> Result<()> {
    let clean = host.trim().trim_matches(['[', ']']);
    if clean.is_empty() {
        return Err("SMTP host не указан".into());
    }
    if is_cloud_metadata_host(clean) {
        return Err("SMTP host указывает на служебную сеть метаданных".into());
    }
    let ip_candidate = clean.split_once('%').map_or(clean, |(prefix, _)| prefix);
    if let Ok(ip) = ip_candidate.parse::<IpAddr>() {
        if is_cloud_metadata_ip(ip) {
            return Err("SMTP host указывает на служебную сеть метаданных".into());
        }
        return Ok(());
    }
    if is_non_canonical_numeric_ip(clean) {
        return Err("SMTP host не должен использовать нестандартную числовую запись IP".into());
    }
    Ok(())
}

pub(crate) async fn resolve_smtp_host(host: &str, port: u16) -> Result<Vec<SocketAddr>> {
    validate_smtp_host(host)?;
    let clean = host.trim().trim_matches(['[', ']']);
    if let Ok(ip) = clean.parse::<IpAddr>() {
        return Ok(vec![SocketAddr::new(ip, port)]);
    }
    let resolved: Vec<SocketAddr> = tokio::net::lookup_host((clean, port)).await?.collect();
    if resolved.is_empty() {
        return Err("Не удалось разрешить адрес SMTP-сервера".into());
    }
    if resolved.iter().any(|addr| is_cloud_metadata_ip(addr.ip())) {
        return Err("SMTP host указывает на служебную сеть метаданных".into());
    }
    Ok(resolved)
}

pub(crate) fn validate_public_url_host(url: &Url) -> Result<()> {
    let Some(host) = url.host() else {
        return Err("Недопустимый URL внешней витрины".into());
    };
    match host {
        Host::Ipv4(v4) if !is_public_ip(IpAddr::V4(v4)) => {
            return Err(
                "Внешняя витрина не может обращаться к локальным или приватным адресам".into(),
            );
        }
        Host::Ipv6(v6) if !is_public_ip(IpAddr::V6(v6)) => {
            return Err(
                "Внешняя витрина не может обращаться к локальным или приватным адресам".into(),
            );
        }
        Host::Domain(domain) => {
            let lower = domain.trim_end_matches('.').to_ascii_lowercase();
            if lower == "localhost"
                || lower.ends_with(".localhost")
                || lower.ends_with(".local")
                || lower.ends_with(".internal")
                || is_cloud_metadata_host(&lower)
            {
                return Err(
                    "Внешняя витрина не может обращаться к локальным или приватным адресам".into(),
                );
            }
        }
        _ => {}
    }
    Ok(())
}

/// DNS resolver that rejects any non-public IP address at connection time
/// (blocking SSRF and DNS-rebinding attacks for external internet fetches).
#[derive(Default)]
pub(crate) struct PublicDnsResolver;

impl Resolve for PublicDnsResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let host = name.as_str().to_owned();
        Box::pin(async move {
            if is_cloud_metadata_host(&host)
                || is_non_canonical_numeric_ip(&host)
                || host.eq_ignore_ascii_case("localhost")
                || host.to_ascii_lowercase().ends_with(".localhost")
            {
                return Err(Box::new(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "blocked non-public host",
                ))
                    as Box<dyn std::error::Error + Send + Sync>);
            }
            let resolved: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), 0))
                .await
                .map_err(|e| Box::new(e) as Box<dyn std::error::Error + Send + Sync>)?
                .collect();
            if resolved.is_empty() || resolved.iter().any(|addr| !is_public_ip(addr.ip())) {
                return Err(Box::new(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "blocked non-public address",
                ))
                    as Box<dyn std::error::Error + Send + Sync>);
            }
            let addrs: Addrs = Box::new(resolved.into_iter());
            Ok(addrs)
        })
    }
}

/// DNS resolver for self-hosted integrations: allows LAN/Docker/localhost,
/// but blocks cloud metadata and link-local addresses (169.254.0.0/16, fe80::/10).
#[derive(Default)]
pub(crate) struct NoMetadataDnsResolver;

impl Resolve for NoMetadataDnsResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let host = name.as_str().to_owned();
        Box::pin(async move {
            if is_cloud_metadata_host(&host) || is_non_canonical_numeric_ip(&host) {
                return Err(Box::new(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "blocked cloud metadata host",
                ))
                    as Box<dyn std::error::Error + Send + Sync>);
            }
            let resolved: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), 0))
                .await
                .map_err(|e| Box::new(e) as Box<dyn std::error::Error + Send + Sync>)?
                .collect();
            if resolved.is_empty() || resolved.iter().any(|addr| is_cloud_metadata_ip(addr.ip())) {
                return Err(Box::new(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "blocked cloud metadata address",
                ))
                    as Box<dyn std::error::Error + Send + Sync>);
            }
            let addrs: Addrs = Box::new(resolved.into_iter());
            Ok(addrs)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_ip_blocks_private_loopback_and_metadata() {
        for blocked in [
            "127.0.0.1",
            "10.0.0.1",
            "172.16.0.1",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "0.0.0.0",
            "::1",
            "fe80::1",
            "fc00::1",
            "fd00:ec2::254",
            "::ffff:127.0.0.1",
            "::ffff:169.254.169.254",
            "::ffff:10.0.0.5",
            "64:ff9b::169.254.169.254",
            "64:ff9b::10.0.0.1",
            "64:ff9b::1.1.1.1",
            "64:ff9b:1::1.1.1.1",
            "100::1",
            "2001::1",
            "2001:0000:4136:e378:8000:63bf:5601:5601",
            "2002:a9fe:a9fe::1",
            "2002:0101:0101::1",
            "::169.254.169.254",
        ] {
            let ip: IpAddr = blocked.parse().unwrap();
            assert!(!is_public_ip(ip), "{blocked} must not be public");
        }
        for allowed in ["93.184.216.34", "1.1.1.1", "2606:4700:4700::1111"] {
            let ip: IpAddr = allowed.parse().unwrap();
            assert!(is_public_ip(ip), "{allowed} should be public");
        }
    }

    #[test]
    fn metadata_filter_allows_lan_and_blocks_metadata() {
        assert!(!is_cloud_metadata_ip("127.0.0.1".parse().unwrap()));
        assert!(!is_cloud_metadata_ip("192.168.1.10".parse().unwrap()));
        assert!(!is_cloud_metadata_ip("172.18.0.5".parse().unwrap()));
        assert!(!is_cloud_metadata_ip("64:ff9b::1.1.1.1".parse().unwrap()));
        assert!(is_cloud_metadata_ip("169.254.169.254".parse().unwrap()));
        assert!(is_cloud_metadata_ip("100.100.100.200".parse().unwrap()));
        assert!(is_cloud_metadata_ip(
            "::ffff:169.254.169.254".parse().unwrap()
        ));
        assert!(is_cloud_metadata_ip(
            "64:ff9b::169.254.169.254".parse().unwrap()
        ));
        assert!(is_cloud_metadata_ip(
            "64:ff9b::100.100.100.200".parse().unwrap()
        ));
        assert!(is_cloud_metadata_ip(
            "64:ff9b:1::169.254.169.254".parse().unwrap()
        ));
        assert!(is_cloud_metadata_ip("2002:a9fe:a9fe::1".parse().unwrap()));
        assert!(is_cloud_metadata_ip(
            "2001:0000:4136:e378:8000:63bf:5601:5601".parse().unwrap()
        ));
        assert!(is_cloud_metadata_ip("::169.254.169.254".parse().unwrap()));
        assert!(is_cloud_metadata_ip("fe80::1".parse().unwrap()));
        assert!(is_cloud_metadata_ip("fd00:ec2::254".parse().unwrap()));
        assert!(is_cloud_metadata_host("metadata.google.internal."));
    }

    #[test]
    fn smtp_and_integration_validation_blocks_metadata_and_numeric_ip_tricks() {
        for blocked in [
            "169.254.169.254",
            "[fe80::1]",
            "[64:ff9b::169.254.169.254]",
            "metadata.google.internal",
            "2852039166",
            "0xa9fea9fe",
            "0251.0376.0251.0376",
            "169.254.43518",
            "0177.0.0.1",
            "169.254.169.254.",
        ] {
            assert!(
                validate_smtp_host(blocked).is_err(),
                "SMTP host should be rejected: {blocked}"
            );
        }
        for allowed in ["127.0.0.1", "[::1]", "relay", "smtp.gmail.com", "10.0.0.5"] {
            assert!(
                validate_smtp_host(allowed).is_ok(),
                "SMTP host should be allowed: {allowed}"
            );
        }
        for blocked_url in [
            "http://169.254.169.254:8080",
            "http://2852039166:8080",
            "http://[64:ff9b::169.254.169.254]:8080",
            "socks5://169.254.169.254:1080",
            "socks5h://169.254.169.254:1080",
            "socks5://2852039166:1080",
            "socks5://0xa9fea9fe:1080",
            "socks5://[64:ff9b::169.254.169.254]:1080",
            "socks5://metadata.google.internal:1080",
        ] {
            let url = Url::parse(blocked_url).unwrap();
            assert!(
                validate_integration_url(&url, "test").is_err(),
                "URL should be rejected: {blocked_url}"
            );
        }
        for allowed_url in [
            "http://127.0.0.1:8080",
            "socks5://127.0.0.1:1080",
            "socks5h://proxy.internal:1080",
            "https://api.telegram.org/",
        ] {
            let url = Url::parse(allowed_url).unwrap();
            assert!(
                validate_integration_url(&url, "test").is_ok(),
                "URL should be allowed: {allowed_url}"
            );
        }
    }
}
