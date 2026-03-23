module.exports = {
  apps: [
    {
      name: "moodle-student-mcp",
      script: "index.js",
      interpreter: "node",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "256M",
      env: {
        NODE_ENV: "production",
        PORT: 3000,
        // MOODLE_URL and token are passed per-request via headers (no config needed here)
      },
    },
  ],
};
