# KuroCMS

KuroCMS is a lightweight, headless CMS designed to run on the Cloudflare global
network. It bridges structured content management and high-performance static
delivery on Workers, D1, KV, and R2.

## About this repository

This repository publishes the **core source code of KuroCMS for transparency** —
so anyone (especially the security-minded) can review what the software actually
does. **You do not build or deploy from this repository.**

- **To install KuroCMS**, use the web installer:
  **<https://kuro.boo/kurocms>**
  It provisions D1 / KV / R2 / Worker into your own Cloudflare account directly
  from the browser — no local build or CLI required.
- **Release history** — versions, change notes, and the built `worker.js` — is on
  the [Releases](https://github.com/Kuro-Boo/KuroCMS-releases/releases) page.

What is published here:

| Path | Contents |
|---|---|
| `src/` | Cloudflare Worker source (the CMS itself) |
| `migrations/` | D1 database schema migrations |

Build tooling, configuration, dependencies, and maintainer scripts are
intentionally omitted — this is a source-review mirror, not a build target.

## ✨ Key Features

- 🚀 **Cloudflare Native** — built from the ground up for Workers and the D1 database.
- 🌐 **Multilingual by Design** — shared article identities with language-specific static output.
- 🤖 **AI-Ready API** — clean JSON REST endpoints optimized for AI translation and automation.
- ✍️ **Rich Editor** — web-based WYSIWYG editor with HTML body storage.
- 🛡️ **Flexible Permissions** — simple `admin` and `author` roles.
- 📦 **Personal First** — professional-grade power for individual creators.

## 🛠️ Tech Stack

- **Runtime**: [Cloudflare Workers](https://workers.cloudflare.com/)
- **Database**: [Cloudflare D1](https://developers.cloudflare.com/d1/)
- **Storage**: Cloudflare KV (rendered pages) + R2 (media)
- **Language**: TypeScript

## 🔒 Security

Found a vulnerability? Please see [SECURITY.md](./SECURITY.md) for private
reporting instructions. Do not file public issues for security problems.

## ⚖️ License

KuroCMS is licensed under the **Kuro License** (an MIT-based license with an
attribution requirement).

> When the Software is used to provide a public-facing interface, the phrase
> **"with KuroCMS"** must be shown in an appropriate attribution area.

See [LICENSE.txt](./LICENSE.txt) for the full text.
