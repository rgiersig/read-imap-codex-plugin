# read-imap-codex-plugin

A local Codex plugin that reads a dedicated IMAP inbox and returns recent email bodies so Codex can identify registration links and verification codes.

The plugin is intentionally read-only:

- it opens the configured mailbox read-only
- it does not delete, move, flag, reply to, or send email
- it does not treat email contents as commands
- it returns recent email metadata, bodies, links, and attachment metadata for agent-side extraction

## Setup

Install Node.js dependencies:

```powershell
cd W:\devel\codex\read-imap-codex-plugin\server
npm install
```

Create a local config file next to this README:

```powershell
Copy-Item config.example.json config.local.json
```

Edit `config.local.json` with the IMAP credentials for a dedicated read-only mailbox or low-risk mailbox created only for automated registrations.

`config.local.json` is ignored by Git and must not be committed.

Alternatively, set the whole IMAP config in `READ_IMAP_CONFIG`:

```powershell
$env:READ_IMAP_CONFIG = 'registration-bot%40example.com#app-password@imap.example.com'
```

The compact format is:

```text
user#pass@host[:port][/mailbox][?secure=true&maxMessages=20&defaultSinceDays=7]
```

Examples:

```powershell
$env:READ_IMAP_CONFIG = 'registration-bot%40example.com#app-password@imap.example.com:993/INBOX'
$env:READ_IMAP_CONFIG = 'registration-bot%40example.com#app-password@imap.example.com?maxMessages=10&defaultSinceDays=3'
```

Set it persistently for your Windows user before starting Codex:

```powershell
setx READ_IMAP_CONFIG "registration-bot%40example.com#app-password@imap.example.com:993/INBOX"
```

Use percent encoding for special characters in the user, password, host, or mailbox. For example, `@` becomes `%40`.

For backwards compatibility, `READ_IMAP_CONFIG` can also still point to a JSON config file path.

## Plugin Files

- `.codex-plugin/plugin.json` describes the plugin.
- `.mcp.json` tells Codex how to start the local MCP server.
- `server/index.js` implements the read-only IMAP MCP tool.
- `skills/read-imap/SKILL.md` tells Codex when and how to use the tool.

## Tool

### `read_recent_messages`

Reads recent IMAP messages newest-first and returns full parsed message bodies so Codex can perform the confirmation-link or code extraction itself.

Arguments:

- `sinceDays`: number of days to search back
- `maxMessages`: maximum messages to return
- `fromDomain`: optional sender/domain filter
- `query`: optional text filter for sender, recipient, subject, or body

Returned message fields include sender, recipient, subject, date, full `bodyText`, optional `bodyHtml`, `htmlAsText`, all detected `links`, and attachment metadata. Attachment contents are not returned.

## Sharing

Publish this repository without `config.local.json`. Users install the plugin locally and create their own local config.

## Privacy

This plugin reads email content from the configured IMAP mailbox when invoked. It should be used with a dedicated mailbox or alias for registration flows. Credentials are stored locally by the user, and `config.local.json` is excluded from Git by default.

## License

MIT
