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
        ANALYZE_URL: process.env.ANALYZE_URL || 'http://127.0.0.1:3002/v1/jobs',
        DEFAULT_WIDTH: process.env.DEFAULT_WIDTH || '',
        DEFAULT_HEIGHT: process.env.DEFAULT_HEIGHT || '',
        DEFAULT_FPS: process.env.DEFAULT_FPS || '',
        DEFAULT_STILL_DURATION_SEC: process.env.DEFAULT_STILL_DURATION_SEC || '',
        DEFAULT_VIDEO_DURATION_SEC: process.env.DEFAULT_VIDEO_DURATION_SEC || '',
        HAILO_HEF_PATH: "/usr/share/hailo-models/yolov8s.hef",
        GST_PLUGIN_PATH: "/lib/aarch64-linux-gnu/gstreamer-1.0:/usr/lib/aarch64-linux-gnu/gstreamer-1.0",
        LD_LIBRARY_PATH: "/usr/lib/aarch64-linux-gnu/hailo/tappas/post_processes:/usr/lib/aarch64-linux-gnu:/usr/lib",
      },
    },
  ],
};
