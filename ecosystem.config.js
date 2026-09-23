module.exports = {
  apps: [
    {
      name: 'file-box',
      script: 'server.js',
      env: {
        PORT: 4444,
        STORAGE_LIMIT_GB: 10,
        RETENTION_DAYS: 30,
      },
      max_memory_restart: '512M',
    },
  ],
};