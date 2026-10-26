// Run from this directory with: npm run pm2:start
// Keep secrets in .env; this file is safe to include in a release.
module.exports = {
  apps: [
    {
      name: "gss-finance",
      cwd: __dirname,
      script: "./dist/server.js",
      interpreter: "node",
      instances: 1,
      exec_mode: "fork",
      watch: false,
      autorestart: true,
      wait_ready: true,
      shutdown_with_message: true,
      listen_timeout: 30000,
      kill_timeout: 15000,
      min_uptime: "10s",
      max_restarts: 10,
      restart_delay: 3000,
      max_memory_restart: "512M",
      time: true,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
