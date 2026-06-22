# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 1.0.x   | Yes       |

## Reporting a Vulnerability

Do not open public GitHub issues for security vulnerabilities.

Email security reports to the repository maintainer or open a private security advisory on GitHub if enabled.

Include:

- Description of the issue
- Steps to reproduce
- Impact assessment
- Suggested fix if available

## Security Model

KoalaChat is designed as a blind relay with client-side end-to-end encryption.

- **Account ID** (16 digits): private credential for WebSocket sessions. Never share.
- **Friend Code** (10 digits): shareable identifier for adding contacts.
- **Private keys**: stored only in the browser. Never sent to the server.
- **Server**: encrypts E2EE payloads at rest in ephemeral buffers but cannot read plaintext.

## Recommendations for Self-Hosters

- Use real TLS certificates in production (Let's Encrypt or your CA).
- Set `KOALA_ALLOW_SELF_SIGNED` unset or `0` in production.
- Run behind a reverse proxy with rate limiting if exposed to the internet.
- Keep Docker and dependencies updated.
- Do not expose port 8999 publicly without TLS termination.