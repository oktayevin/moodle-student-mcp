# Moodle Student MCP

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server that connects AI assistants (Claude, Poke.com, etc.) to any Moodle LMS instance using token-based authentication.

Ask your AI assistant things like:
- *"What assignments do I have due this week?"*
- *"Show me my grades for the Database course"*
- *"List the files in my Computer Networks course"*
- *"Submit my assignment with this text: ..."*

---

## Features

- 18 tools covering the full student workflow
- Works with any Moodle instance (URL passed per-request — no server config needed)
- Token passed per-request — supports multiple users on a single server
- SSE transport for Poke.com and compatible clients
- Streamable HTTP transport for Claude Desktop and compatible clients
- Deploy anywhere: DigitalOcean, Railway, Render, VPS, etc.

---

## Tools

| Tool | Description |
|---|---|
| `get_site_info` | Site info and authenticated user profile |
| `get_enrolled_courses` | List all enrolled courses |
| `get_course_contents` | Sections, resources, and activities in a course |
| `get_assignments` | Assignments for one or all courses |
| `get_assignment_submission_status` | Submission status and feedback for an assignment |
| `get_course_grades` | Grade items and scores for a course |
| `get_upcoming_events` | Calendar events and deadlines |
| `get_notifications` | User notifications |
| `get_conversations` | Message conversations |
| `get_forum_discussions` | Forum discussions in a course |
| `get_quiz_attempts` | Quiz attempt history |
| `get_course_participants` | Enrolled participants in a course |
| `get_user_profile` | User profile details |
| `mark_notifications_read` | Mark all notifications as read |
| `search_courses` | Search for courses on the site |
| `get_course_files` | List course files with authenticated download URLs; optionally fetch text file contents |
| `submit_assignment_text` | Submit an online text response to an assignment |
| `submit_assignment_file` | Upload a file (base64) and submit it to an assignment |

---

## Getting Your Moodle Token

1. Log in to your Moodle site
2. Go to **User menu → Preferences → Security keys**
3. Find or generate a token for **Moodle mobile web service** (or any enabled web service)
4. Copy the token

---

## Deployment

### Prerequisites

- Node.js 18+
- A server or VPS (DigitalOcean, Railway, Render, etc.)

### 1. Clone and install

```bash
git clone https://github.com/oktayevin/moodle-student-mcp.git
cd moodle-student-mcp
npm install --omit=dev
```

### 2. Start with PM2 (recommended for VPS)

```bash
npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup   # follow the printed command to enable auto-start on reboot
```

The server starts on port `3000` by default. To use a different port:

```bash
PORT=8080 pm2 start ecosystem.config.cjs
```

### 3. Open the firewall port (if needed)

```bash
ufw allow 3000
```

---

## Connecting an AI Client

Both the **Moodle URL** and **token** are passed per-request via headers — no `.env` file required.

### Poke.com

| Field | Value |
|---|---|
| **Server URL** | `http://YOUR_SERVER_IP:3000/sse?moodle_url=https://your-moodle-site.com` |
| **API Key** | Your Moodle token |

### Claude Desktop

Add to `~/.claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "moodle-student": {
      "type": "http",
      "url": "http://YOUR_SERVER_IP:3000/mcp",
      "headers": {
        "X-Api-Key": "your_moodle_token",
        "X-Moodle-URL": "https://your-moodle-site.com"
      }
    }
  }
}
```

### Any SSE-compatible client

- **SSE endpoint:** `GET /sse`
- **Messages endpoint:** `POST /messages`
- **Streamable HTTP endpoint:** `POST /mcp`
- **Health check:** `GET /health`

Required headers on every request:

| Header | Description |
|---|---|
| `X-Api-Key` | Your Moodle web service token |
| `X-Moodle-URL` | Your Moodle site URL (or pass as `?moodle_url=` query param) |

---

## Running Locally (for development)

```bash
npm install
X-Api-Key=your_token X-Moodle-URL=https://your-moodle.com node index.js
```

Or set environment variables and pass headers via your MCP client.

---

## Architecture

```
AI Client (Poke.com / Claude Desktop)
        │
        │  SSE or Streamable HTTP
        ▼
Moodle Student MCP Server  (Node.js / Express)
        │
        │  Moodle REST API (wstoken auth)
        ▼
   Moodle LMS Instance
```

- **Stateless design** — each request creates a fresh MCP server instance
- **No database** — all state lives in Moodle
- **Multi-tenant** — different users can connect with their own URLs and tokens

---

## License

MIT
