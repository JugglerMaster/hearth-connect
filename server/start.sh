npm install
# if you changed anything under server/src/ (TypeScript), rebuild first:
npm run build

# run it (matches the systemd unit):
SERVER_PORT=8090 NODE_ENV=production node dist/index.js --tls
