module.exports = {
  apps: [
    {
      name: 'heat-ocr',
      script: '/home/user/webapp/server.mjs',
      interpreter: 'node',
      cwd: '/home/user/webapp',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
        GENSPARK_TOKEN: process.env.GENSPARK_TOKEN || ''
      },
      watch: false,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 5
    }
  ]
}
