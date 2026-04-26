# inpx-web-7z

Self-hosted web catalog and FB2 reader for large `.inpx`, `.zip`, `.7z` and `fLibrary` book collections.

This image is built from the [`AceAsket/inpx-web`](https://github.com/AceAsket/inpx-web) fork and is aimed at Docker, Unraid, Proxmox LXC and home-server setups.

## What Is Included

- Web catalog with search by authors, series, titles, genres, languages and sources.
- Multiple library sources through `INPX_LIBRARY_SOURCES`.
- Large `.zip` / `.7z` / `fLibrary` collection support.
- Cover extraction and cache, including `covers`, `images`, WebP and JXL helpers.
- Built-in FB2 reader with profiles, progress, bookmarks, themes, fonts, Wake Lock and separate PWA mode.
- Personal reading lists, read/unread marks, OPDS and profile-level OPDS links.
- Book sending by Telegram and email when configured.
- Conversion to `epub`, `epub3`, `kepub`, `kfx`, `azw8` and `pdf` in the default image.
- Admin dashboard, event log, backup/restore, source management, health checks and Prometheus metrics.

## Tags

| Tag | Purpose |
| --- | --- |
| `latest` | Current stable full image with fb2cng, MuPDF, 7z, JXL and WebP tools. |
| `1.6.8` | Pinned stable release. Recommended for reproducible deployments. |
| `lite` | Smaller image without book conversion tools. Catalog, reader, OPDS, covers and 7z support remain available. |
| `1.6.8-lite` | Pinned lite release. |

The default image does not include Calibre. Calibre is available only when building the `runtime-calibre` target from the repository Dockerfile.

## Quick Start

Single library source:

```sh
docker run -d \
  --name=inpx-web \
  --restart unless-stopped \
  -p 12380:12380 \
  -e DATA_DIR=/usr/local/bin/.inpx-web \
  -e INPX=/library/my-library.inpx \
  -e LIBDIR=/library \
  -e CACHE_DIR=/usr/local/bin/.inpx-web/cache \
  -e INPX_COVER_CACHE_SIZE_MB=512 \
  -v /mnt/user/appdata/inpx-web:/usr/local/bin/.inpx-web \
  -v /mnt/user/books/my-library:/library:ro \
  aceasket/inpx-web-7z:latest
```

Open:

```text
http://SERVER_IP:12380
```

Important: `INPX` and `LIBDIR` must use paths inside the container. They must match the right side of the volume mount.

## Multiple Library Sources

Use `INPX_LIBRARY_SOURCES` when several libraries are mounted at once:

```sh
docker run -d \
  --name=inpx-web \
  --restart unless-stopped \
  -p 12380:12380 \
  -e DATA_DIR=/usr/local/bin/.inpx-web \
  -e CACHE_DIR=/usr/local/bin/.inpx-web/cache \
  -e INPX_COVER_CACHE_SIZE_MB=512 \
  -e INPX_LIBRARY_SOURCES='[
    {"id":"lib-rus-ec-official","name":"Lib.rus.ec official","inpx":"/library/_Lib.rus.ec - Official/librusec_local_fb2.inpx","libDir":"/library/_Lib.rus.ec - Official"},
    {"id":"flibusta-rus-ec","name":"Flibusta lib.rus.ec","inpx":"/library/fb2.flibusta.lib.rus.ec.7z/fb2.flibusta.lib.rus.ec.7z.inpx","libDir":"/library/fb2.flibusta.lib.rus.ec.7z"},
    {"id":"flibusta-net","name":"Fb2.Flibusta.Net","inpx":"/library/fb2.Flibusta.Net/flibusta_fb2_local.inpx","libDir":"/library/fb2.Flibusta.Net"}
  ]' \
  -v /mnt/user/appdata/inpx-web:/usr/local/bin/.inpx-web \
  -v /mnt/user/Torrents:/library:ro \
  aceasket/inpx-web-7z:latest
```

For one source in JSON, do not leave a trailing comma before `]`.

## Docker Compose

```yaml
services:
  inpx-web:
    image: aceasket/inpx-web-7z:latest
    container_name: inpx-web
    restart: unless-stopped
    ports:
      - "12380:12380"
    environment:
      DATA_DIR: /usr/local/bin/.inpx-web
      INPX: /library/my-library.inpx
      LIBDIR: /library
      CACHE_DIR: /usr/local/bin/.inpx-web/cache
      INPX_COVER_CACHE_SIZE_MB: "512"
    volumes:
      - /mnt/user/appdata/inpx-web:/usr/local/bin/.inpx-web
      - /mnt/user/books/my-library:/library:ro
```

## Persistent Data

Keep `/usr/local/bin/.inpx-web` in a persistent volume. It stores:

- `config.json`
- `secret.key`
- user profiles
- reading lists
- reading progress
- bookmarks
- discovery cache
- search DB
- cover cache

The book library itself should normally be mounted read-only at `/library`.

## Backups

The admin panel has two different exports:

- Full backup: `config.json`, `secret.key`, profiles, reading lists, progress, bookmarks, hidden books and discovery cache.
- Settings export: configuration only, without users and reading progress.

Each user profile also has a separate `Backup` tab in the profile dialog. It exports personal lists, progress, bookmarks, hidden books and reader settings. Profile passwords are not exported.

Book archives, generated cover cache, temporary caches and the search DB are not included in the full backup archive.

After restoring a full backup, restart the container. If library sources changed, reindex the catalog.

## Useful Environment Variables

| Variable | Description |
| --- | --- |
| `DATA_DIR` | Persistent app data directory. Default in Docker: `/usr/local/bin/.inpx-web`. |
| `INPX` | Path to a single `.inpx` file inside the container. |
| `LIBDIR` | Path to a single library directory inside the container. |
| `INPX_LIBRARY_SOURCES` | JSON array or compact string with multiple library sources. |
| `CACHE_DIR` | Prepared book/conversion cache path. |
| `INPX_COVER_CACHE_SIZE_MB` | Cover cache size limit in MB. Default: `512`. |
| `INPX_METRICS_ENABLED` | Enable Prometheus metrics when `true`. |
| `INPX_METRICS_PATH` | Metrics endpoint path. Default: `/metrics`. |
| `INPX_REQUIRE_AUTH` | Require app-level auth for all non-exempt requests. |
| `INPX_AUTH_MODE` | Use `proxy` for Authelia/Authentik/SWAG-style trusted proxy auth. |
| `INPX_TRUST_PROXY` | Trust reverse proxy headers when `true`. |
| `INPX_TRUSTED_PROXY_CIDRS` | Comma-separated trusted proxy CIDR list. |

## Health And Metrics

Available endpoints:

- `/health`
- `/ready`
- `/api/index-status`
- `/metrics` when `INPX_METRICS_ENABLED=true`

Example:

```sh
docker run -d \
  --name=inpx-web \
  --restart unless-stopped \
  -p 12380:12380 \
  -e DATA_DIR=/usr/local/bin/.inpx-web \
  -e INPX=/library/my-library.inpx \
  -e LIBDIR=/library \
  -e INPX_METRICS_ENABLED=true \
  -e INPX_METRICS_PATH=/metrics \
  -v /mnt/user/appdata/inpx-web:/usr/local/bin/.inpx-web \
  -v /mnt/user/books/my-library:/library:ro \
  aceasket/inpx-web-7z:latest
```

## Reverse Proxy Auth

For public access, put the service behind SWAG, Authelia or Authentik and do not expose port `12380` directly to the internet.

Example proxy-auth hardening:

```sh
-e INPX_REQUIRE_AUTH=true \
-e INPX_AUTH_MODE=proxy \
-e INPX_TRUST_PROXY=true \
-e INPX_TRUSTED_PROXY_CIDRS=172.18.0.0/16
```

In this mode direct access that bypasses the trusted reverse proxy is rejected.

## Telegram And Email

Telegram and SMTP can be configured either from the admin UI or through environment variables. Books are sent only to the current profile's personal Telegram chat id or email address. Global fallback recipients are intentionally not used.

## Lite Image

Use `aceasket/inpx-web-7z:lite` or a pinned lite tag when conversion is not needed:

```sh
docker run -d \
  --name=inpx-web \
  --restart unless-stopped \
  -p 12380:12380 \
  -e INPX=/library/my-library.inpx \
  -e LIBDIR=/library \
  -v /mnt/user/appdata/inpx-web:/usr/local/bin/.inpx-web \
  -v /mnt/user/books/my-library:/library:ro \
  aceasket/inpx-web-7z:lite
```

Lite keeps catalog, reader, profiles, OPDS, 7z support and cover extraction, but disables conversion formats.

## Links

- GitHub: <https://github.com/AceAsket/inpx-web>
- Releases: <https://github.com/AceAsket/inpx-web/releases>
- Issues: <https://github.com/AceAsket/inpx-web/issues>
