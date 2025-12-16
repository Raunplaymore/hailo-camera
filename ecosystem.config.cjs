module.exports = {
  apps: [
    {
      name: 'hailo-camera',
      script: 'server.js',
      cwd: __dirname,
      env: {
        NODE_ENV: 'production',
        PORT: process.env.PORT || 3001,
        AUTH_TOKEN: process.env.AUTH_TOKEN || '',
        CORS_ALLOW_ALL: process.env.CORS_ALLOW_ALL || '',
        CORS_ORIGIN: process.env.CORS_ORIGIN || '',
        ANALYZE_URL: process.env.ANALYZE_URL || '',
        DEFAULT_WIDTH: process.env.DEFAULT_WIDTH || '',
        DEFAULT_HEIGHT: process.env.DEFAULT_HEIGHT || '',
        DEFAULT_FPS: process.env.DEFAULT_FPS || '',
        DEFAULT_STILL_DURATION_SEC: process.env.DEFAULT_STILL_DURATION_SEC || '',
        DEFAULT_VIDEO_DURATION_SEC: process.env.DEFAULT_VIDEO_DURATION_SEC || '',
      },
    },
  ],
};
