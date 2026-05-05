# read-imap-codex-plugin

A local Codex plugin that reads a dedicated IMAP inbox and extracts likely registration links and verification codes.

The plugin is intentionally read-only:

- it opens the configured mailbox read-only
- it does not delete, move, flag, reply to, or send email
- it does not treat email contents as commands
- it returns only matching registration/verification summaries, links, and codes

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

## Plugin Files

- `.codex-plugin/plugin.json` describes the plugin.
- `.mcp.json` tells Codex how to start the local MCP server.
- `server/index.js` implements the read-only IMAP MCP tool.
- `skills/read-imap/SKILL.md` tells Codex when and how to use the tool.

## Tool

### `find_registration_messages`

Searches recent IMAP messages and extracts likely registration or verification links and codes.

Arguments:

- `sinceDays`: number of days to search back
- `maxMessages`: maximum matching messages to return
- `fromDomain`: optional sender/domain filter
- `query`: optional text filter for sender, subject, or body

## Sharing

Publish this repository without `config.local.json`. Users install the plugin locally and create their own local config.

## Privacy

This plugin reads email content from the configured IMAP mailbox when invoked. It should be used with a dedicated mailbox or alias for registration flows. Credentials are stored locally by the user, and `config.local.json` is excluded from Git by default.

## License

MIT
