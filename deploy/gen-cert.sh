#!/bin/bash
# Generate self-signed CA + server cert for hearth-connect
# CA cert must be installed on iOS devices (Settings → Profile)

set -e

DOMAIN="${1:-hearth.local}"
CERT_DIR="${2:-./certs}"

mkdir -p "$CERT_DIR"

# 1. Generate CA key and cert
openssl genrsa -out "$CERT_DIR/ca.key" 2048
openssl req -x509 -new -nodes \
  -key "$CERT_DIR/ca.key" \
  -sha256 -days 3650 \
  -out "$CERT_DIR/ca.pem" \
  -subj "/CN=HearthConnect CA/O=HearthConnect"

# 2. Generate server key
openssl genrsa -out "$CERT_DIR/server.key" 2048

# 3. Generate server CSR
openssl req -new \
  -key "$CERT_DIR/server.key" \
  -out "$CERT_DIR/server.csr" \
  -subj "/CN=$DOMAIN/O=HearthConnect"

# 4. Sign server cert with CA
cat > "$CERT_DIR/server.ext" << EOF
authorityKeyIdentifier=keyid,issuer
basicConstraints=CA:FALSE
keyUsage=digitalSignature,nonRepudiation,keyEncipherment,dataEncipherment
subjectAltName=@alt_names

[alt_names]
DNS.1=$DOMAIN
DNS.2=localhost
IP.1=127.0.0.1
EOF

openssl x509 -req \
  -in "$CERT_DIR/server.csr" \
  -CA "$CERT_DIR/ca.pem" \
  -CAkey "$CERT_DIR/ca.key" \
  -CAcreateserial \
  -out "$CERT_DIR/server.crt" \
  -days 365 \
  -sha256 \
  -extfile "$CERT_DIR/server.ext"

# 5. Cleanup
rm "$CERT_DIR/server.csr" "$CERT_DIR/server.ext"

echo "---"
echo "Certificates generated in $CERT_DIR/"
echo ""
echo "Install CA on iOS:"
echo "  1. Serve $CERT_DIR/ca.pem via web or email to device"
echo "  2. Open on iOS → Settings → Profile Downloaded → Install"
echo "  3. Settings → General → About → Certificate Trust Settings"
echo "  4. Enable \"HearthConnect CA\""
echo ""
echo "Server cert:  $CERT_DIR/server.crt"
echo "Server key:   $CERT_DIR/server.key"
echo "CA cert:      $CERT_DIR/ca.pem"
echo "CA key:       $CERT_DIR/ca.key (keep safe)"
