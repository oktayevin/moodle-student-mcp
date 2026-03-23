#!/usr/bin/env node

import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";

const PORT = parseInt(process.env.PORT || "3000", 10);
// Both MOODLE_URL and token are read per-request from headers

// ─── Moodle API helper ────────────────────────────────────────────────────────

async function moodleCall(wsfunction, params = {}, token, moodleUrl) {
  const base = moodleUrl.replace(/\/$/, "");
  const body = new URLSearchParams();
  body.set("wstoken", token);
  body.set("wsfunction", wsfunction);
  body.set("moodlewsrestformat", "json");
  flattenParams(params, "", body);

  const res = await fetch(`${base}/webservice/rest/server.php`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  }

  const data = await res.json();

  if (data && data.exception) {
    throw new Error(`Moodle [${data.errorcode}]: ${data.message}`);
  }

  return data;
}

function flattenParams(obj, prefix, params) {
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        if (typeof item === "object" && item !== null) {
          flattenParams(item, `${fullKey}[${i}]`, params);
        } else {
          params.set(`${fullKey}[${i}]`, String(item));
        }
      });
    } else if (typeof value === "object" && value !== null) {
      flattenParams(value, fullKey, params);
    } else {
      params.set(fullKey, String(value));
    }
  }
}

const ok = (data) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
const fail = (e) => ({ content: [{ type: "text", text: `Error: ${e.message}` }], isError: true });

// ─── MCP Server factory (one instance per request for stateless HTTP) ─────────

function createServer(token, moodleUrl) {
  const server = new McpServer({ name: "moodle-student", version: "1.0.0" });
  const call = (fn, params) => moodleCall(fn, params, token, moodleUrl);

  // 1. Site info & current user
  server.tool("get_site_info", "Get Moodle site information and the authenticated user's profile", {}, async () => {
    try { return ok(await call("core_webservice_get_site_info")); }
    catch (e) { return fail(e); }
  });

  // 2. Enrolled courses
  server.tool(
    "get_enrolled_courses",
    "List all courses the current user is enrolled in",
    { userid: z.number().optional().describe("User ID (defaults to token owner)") },
    async ({ userid } = {}) => {
      try {
        const info = await call("core_webservice_get_site_info");
        return ok(await call("core_enrol_get_users_courses", { userid: userid ?? info.userid }));
      } catch (e) { return fail(e); }
    }
  );

  // 3. Course contents
  server.tool(
    "get_course_contents",
    "Get the full content tree of a course (sections, resources, activities)",
    { courseid: z.number().describe("Course ID") },
    async ({ courseid }) => {
      try { return ok(await call("core_course_get_contents", { courseid })); }
      catch (e) { return fail(e); }
    }
  );

  // 4. Assignments
  server.tool(
    "get_assignments",
    "Get assignments for one or more courses (omit courseids to get all enrolled courses)",
    { courseids: z.array(z.number()).optional().describe("Course IDs (omit for all enrolled)") },
    async ({ courseids } = {}) => {
      try {
        let ids = courseids;
        if (!ids || ids.length === 0) {
          const info = await call("core_webservice_get_site_info");
          const courses = await call("core_enrol_get_users_courses", { userid: info.userid });
          ids = courses.map((c) => c.id);
        }
        return ok(await call("mod_assign_get_assignments", { courseids: ids }));
      } catch (e) { return fail(e); }
    }
  );

  // 5. Assignment submission status
  server.tool(
    "get_assignment_submission_status",
    "Get the current user's submission status and feedback for a specific assignment",
    { assignid: z.number().describe("Assignment ID") },
    async ({ assignid }) => {
      try { return ok(await call("mod_assign_get_submission_status", { assignid })); }
      catch (e) { return fail(e); }
    }
  );

  // 6. Course grades
  server.tool(
    "get_course_grades",
    "Get grade items and the current user's grades for a course",
    {
      courseid: z.number().describe("Course ID"),
      userid: z.number().optional().describe("User ID (defaults to token owner)"),
    },
    async ({ courseid, userid }) => {
      try {
        const info = await call("core_webservice_get_site_info");
        return ok(await call("gradereport_user_get_grade_items", { courseid, userid: userid ?? info.userid }));
      } catch (e) { return fail(e); }
    }
  );

  // 7. Upcoming events
  server.tool(
    "get_upcoming_events",
    "Get upcoming calendar events and assignment deadlines",
    {
      timestart: z.number().optional().describe("Unix timestamp to start from (defaults to now)"),
      limit: z.number().optional().default(20).describe("Maximum events to return"),
    },
    async ({ timestart, limit = 20 } = {}) => {
      try {
        return ok(await call("core_calendar_get_action_events_by_timesort", {
          timesortfrom: timestart ?? Math.floor(Date.now() / 1000),
          limitnum: limit,
        }));
      } catch (e) { return fail(e); }
    }
  );

  // 8. Notifications
  server.tool(
    "get_notifications",
    "Get the current user's notifications",
    {
      limit: z.number().optional().default(20).describe("Max notifications to return"),
      offset: z.number().optional().default(0).describe("Pagination offset"),
    },
    async ({ limit = 20, offset = 0 } = {}) => {
      try {
        const info = await call("core_webservice_get_site_info");
        return ok(await call("message_popup_get_popup_notifications", {
          useridto: info.userid, newestfirst: 1, limit, offset,
        }));
      } catch (e) { return fail(e); }
    }
  );

  // 9. Conversations
  server.tool(
    "get_conversations",
    "Get the current user's message conversations",
    {
      limit: z.number().optional().default(10).describe("Number of conversations"),
      offset: z.number().optional().default(0).describe("Pagination offset"),
    },
    async ({ limit = 10, offset = 0 } = {}) => {
      try {
        const info = await call("core_webservice_get_site_info");
        return ok(await call("core_message_get_conversations", {
          userid: info.userid, limitnum: limit, limitfrom: offset,
        }));
      } catch (e) { return fail(e); }
    }
  );

  // 10. Forum discussions
  server.tool(
    "get_forum_discussions",
    "Get discussions for a specific forum activity",
    {
      forumid: z.number().describe("Forum activity ID"),
      page: z.number().optional().default(0).describe("Page number"),
      perpage: z.number().optional().default(10).describe("Discussions per page"),
    },
    async ({ forumid, page = 0, perpage = 10 }) => {
      try { return ok(await call("mod_forum_get_forum_discussions", { forumid, page, perpage })); }
      catch (e) { return fail(e); }
    }
  );

  // 11. Quiz attempts
  server.tool(
    "get_quiz_attempts",
    "Get the current user's attempts for a specific quiz",
    {
      quizid: z.number().describe("Quiz activity ID"),
      userid: z.number().optional().describe("User ID (defaults to token owner)"),
    },
    async ({ quizid, userid }) => {
      try {
        const info = await call("core_webservice_get_site_info");
        return ok(await call("mod_quiz_get_attempts_by_quiz", { quizid, userid: userid ?? info.userid }));
      } catch (e) { return fail(e); }
    }
  );

  // 12. Course participants
  server.tool(
    "get_course_participants",
    "Get participants enrolled in a course",
    {
      courseid: z.number().describe("Course ID"),
      limit: z.number().optional().default(50).describe("Max participants to return"),
    },
    async ({ courseid, limit = 50 }) => {
      try {
        return ok(await call("core_enrol_get_enrolled_users", {
          courseid,
          options: [{ name: "limitnumber", value: limit }],
        }));
      } catch (e) { return fail(e); }
    }
  );

  // 13. User profile
  server.tool(
    "get_user_profile",
    "Get a user's profile details",
    { userid: z.number().optional().describe("User ID (defaults to token owner)") },
    async ({ userid } = {}) => {
      try {
        const info = await call("core_webservice_get_site_info");
        return ok(await call("core_user_get_users_by_field", {
          field: "id", values: [userid ?? info.userid],
        }));
      } catch (e) { return fail(e); }
    }
  );

  // 14. Mark notifications read
  server.tool(
    "mark_notifications_read",
    "Mark all notifications as read",
    { timetokenread: z.number().optional().describe("Unix timestamp (defaults to now)") },
    async ({ timetokenread } = {}) => {
      try {
        const info = await call("core_webservice_get_site_info");
        return ok(await call("message_popup_mark_all_notifications_as_read", {
          useridto: info.userid,
          useridfrom: 0,
          timetokenread: timetokenread ?? Math.floor(Date.now() / 1000),
        }));
      } catch (e) { return fail(e); }
    }
  );

  // 15. Search courses
  server.tool(
    "search_courses",
    "Search for courses on the Moodle site",
    {
      query: z.string().describe("Search keyword"),
      limit: z.number().optional().default(20).describe("Max results to return"),
    },
    async ({ query, limit = 20 }) => {
      try {
        return ok(await call("core_course_search_courses", {
          criterianame: "search", criteriavalue: query, page: 0, perpage: limit,
        }));
      } catch (e) { return fail(e); }
    }
  );

  // 16. Get course files with authenticated download URLs
  server.tool(
    "get_course_files",
    "List all downloadable files in a course with their authenticated URLs. For text/code files, fetches the actual content.",
    {
      courseid: z.number().describe("Course ID"),
      fetch_content: z
        .boolean()
        .optional()
        .default(false)
        .describe("Fetch file contents for plain-text files (txt, md, html, py, js, etc.)"),
    },
    async ({ courseid, fetch_content = false }) => {
      try {
        const sections = await call("core_course_get_contents", { courseid });
        const files = [];

        for (const section of sections) {
          for (const module of section.modules ?? []) {
            for (const f of module.contents ?? []) {
              if (f.type !== "file" && f.type !== "url") continue;

              // Append token so the URL is directly accessible
              const authedUrl = f.fileurl.includes("?")
                ? `${f.fileurl}&token=${token}`
                : `${f.fileurl}?token=${token}`;

              const entry = {
                section: section.name,
                module: module.name,
                filename: f.filename,
                mimetype: f.mimetype,
                filesize: f.filesize,
                timemodified: f.timemodified,
                url: authedUrl,
              };

              // Optionally fetch content for text-based files
              if (fetch_content && isTextFile(f.filename, f.mimetype)) {
                try {
                  const r = await fetch(authedUrl);
                  if (r.ok) entry.content = await r.text();
                } catch {
                  entry.content = null;
                }
              }

              files.push(entry);
            }
          }
        }

        return ok({ total: files.length, files });
      } catch (e) { return fail(e); }
    }
  );

  // 17. Submit text (online text) to an assignment
  server.tool(
    "submit_assignment_text",
    "Submit an online text response to a Moodle assignment",
    {
      assignid: z.number().describe("Assignment ID"),
      text: z.string().describe("The text content to submit (HTML is supported)"),
    },
    async ({ assignid, text }) => {
      try {
        const data = await call("mod_assign_save_submission", {
          assignmentid: assignid,
          plugindata: {
            onlinetext_editor: {
              text,
              format: 1, // HTML
              itemid: 0,
            },
          },
        });
        return ok({ success: true, result: data });
      } catch (e) { return fail(e); }
    }
  );

  // 18. Upload a file and submit it to an assignment
  server.tool(
    "submit_assignment_file",
    "Upload a file and submit it to a Moodle assignment. File content must be base64-encoded.",
    {
      assignid: z.number().describe("Assignment ID"),
      filename: z.string().describe("File name including extension (e.g. report.pdf)"),
      filecontent_base64: z.string().describe("Base64-encoded file content"),
    },
    async ({ assignid, filename, filecontent_base64 }) => {
      try {
        // Step 1: Upload file to draft area
        const upload = await call("core_files_upload", {
          component: "user",
          filearea: "draft",
          itemid: 0,
          filepath: "/",
          filename,
          filecontent: filecontent_base64,
          contextlevel: "user",
          instanceid: (await call("core_webservice_get_site_info")).userid,
        });

        const itemid = upload.itemid;

        // Step 2: Submit with the draft itemid
        const data = await call("mod_assign_save_submission", {
          assignmentid: assignid,
          plugindata: {
            files_filemanager: itemid,
          },
        });

        return ok({ success: true, itemid, result: data });
      } catch (e) { return fail(e); }
    }
  );

  return server;
}

function isTextFile(filename, mimetype) {
  const textMimes = ["text/", "application/json", "application/xml", "application/javascript"];
  const textExts = [".txt", ".md", ".html", ".htm", ".csv", ".json", ".xml", ".py", ".js", ".ts", ".java", ".c", ".cpp", ".cs", ".go", ".rs", ".rb", ".php", ".sql", ".sh", ".yaml", ".yml"];
  if (textMimes.some((m) => (mimetype ?? "").startsWith(m))) return true;
  if (textExts.some((e) => filename.toLowerCase().endsWith(e))) return true;
  return false;
}

// ─── Express HTTP server ──────────────────────────────────────────────────────

const app = express();

// Health check (no auth required)
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "moodle-student-mcp" });
});

// Extract Moodle token and URL from request headers
function extractCredentials(req, res) {
  const token =
    req.headers["x-api-key"] ||
    req.headers["authorization"]?.replace(/^Bearer\s+/i, "") ||
    req.query.token;
  const moodleUrl =
    req.headers["x-moodle-url"] ||
    req.query.moodle_url;

  if (!token) {
    res.status(401).json({ error: "Missing token — set X-Api-Key header to your Moodle token" });
    return null;
  }
  if (!moodleUrl) {
    res.status(400).json({ error: "Missing Moodle URL — set X-Moodle-URL header (e.g. https://learn.example.com)" });
    return null;
  }
  return { token, moodleUrl };
}

// MCP endpoint — stateless: one server + transport per request
app.post("/mcp", async (req, res) => {
  const creds = extractCredentials(req, res);
  if (!creds) return;

  // Read and parse body manually (avoids express.json() consuming the stream)
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString()); }
  catch { body = undefined; }

  const server = createServer(creds.token, creds.moodleUrl);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless mode
  });

  res.on("finish", () => server.close().catch(() => {}));

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (e) {
    console.error("MCP request error:", e);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

// MCP spec: GET and DELETE on /mcp should return 405 for stateless servers
app.get("/mcp", (_req, res) => res.status(405).json({ error: "Method not allowed" }));
app.delete("/mcp", (_req, res) => res.status(405).json({ error: "Method not allowed" }));

// ─── SSE transport (for Poke.com and other SSE-based clients) ────────────────

const sseSessions = new Map(); // sessionId → { transport, server }

app.get("/sse", async (req, res) => {
  const creds = extractCredentials(req, res);
  if (!creds) return;

  const transport = new SSEServerTransport("/messages", res);
  const server = createServer(creds.token, creds.moodleUrl);

  sseSessions.set(transport.sessionId, { transport, server });

  res.on("close", () => {
    sseSessions.delete(transport.sessionId);
    server.close().catch(() => {});
  });

  await server.connect(transport);
});

app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId;
  const session = sseSessions.get(sessionId);

  if (!session) {
    return res.status(404).json({ error: "Session not found" });
  }

  await session.transport.handlePostMessage(req, res);
});

app.listen(PORT, () => {
  console.log(`Moodle Student MCP server listening on port ${PORT}`);
  console.log(`  Health: http://localhost:${PORT}/health`);
  console.log(`  MCP:    http://localhost:${PORT}/mcp  (Streamable HTTP)`);
  console.log(`  SSE:    http://localhost:${PORT}/sse  (Poke.com / SSE clients)`);
  console.log(`  Auth:   X-Api-Key = Moodle token (required)`)
});
