module.exports = {
  apps: [
    {
      name: 'file-box',
      script: 'server.js',
      env: {
        PORT: 4444,        // HTTP 端口（可直接用）
        HTTPS_PORT: 3443,  // HTTPS 端口（推荐，首次访问需信任自签证书一次）
        STORAGE_LIMIT_GB: 10,
        RETENTION_DAYS: 30,
      },
      max_memory_restart: '512M',
    },
  ],
};