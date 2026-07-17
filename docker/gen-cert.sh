#!/bin/bash
# Generate or re-issue the Hearth-Connect server TLS cert.
#
# The CA is created once and reused on subsequent runs (so iOS devices that
# already trust it don't need to re-install the profile). The server cert's
# subjectAltName includes the domain, localhost, 127.0.0.1, and any extra IPs
# passed via EXTRA_IPS (comma-separated) — e.g. the host's LAN IP so devices
# reaching https://<lan-ip>:8090 don't get a name-mismatch warning (which would
# otherwise force a fresh camera/mic permission prompt on every reload).
#
# CA cert must be installed on iOS: Settings → Profile Downloaded → Install,
# then Settings → General → About → Certificate Trust Settings → enable it.

set -e

DOMAIN="${1:-hearth.local}"
CERT_DIR="${2:-./certs}"
EXTRA_IPS="${EXTRA_IPS:-}"

mkdir -p "$CERT_DIR"

# 1. CA — reuse if it already exists, else create it.
if [[ -f "$CERT_DIR/ca.pem" && -f "$CERT_DIR/ca.key" ]]; then
  echo "Reusing existing CA ($CERT_DIR/ca.pem)"
else
  echo "Generating CA…"
  openssl genrsa -out "$CERT_DIR/ca.key" 2048
  openssl req -x509 -new -nodes \
    -key "$CERT_DIR/ca.key" \
    -sha256 -days 3650 \
    -out "$CERT_DIR/ca.pem" \
    -subj "/CN=HearthConnect CA/O=HearthConnect"
fi

# 2. Server key
openssl genrsa -out "$CERT_DIR/server.key" 2048

# 3. Server CSR
openssl req -new \
  -key "$CERT_DIR/server.key" \
  -out "$CERT_DIR/server.csr" \
  -subj "/CN=$DOMAIN/O=HearthConnect"

# 4. SAN extension file (domain + localhost + 127.0.0.1 + any EXTRA_IPS)
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

ip_idx=2
IFS=',' read -ra IPS <<< "$EXTRA_IPS"
for ip in "${IPS[@]}"; do
  ip="$(echo -n "$ip" | tr -d '[:space:]')"
  [[ -z "$ip" ]] && continue
  echo "IP.$ip_idx=$ip" >> "$CERT_DIR/server.ext"
  ip_idx=$((ip_idx + 1))
done

# 5. Sign server cert with the CA
openssl x509 -req \
  -in "$CERT_DIR/server.csr" \
  -CA "$CERT_DIR/ca.pem" \
  -CAkey "$CERT_DIR/ca.key" \
  -CAcreateserial \
  -out "$CERT_DIR/server.crt" \
  -days 365 \
  -sha256 \
  -extfile "$CERT_DIR/server.ext"

# 6. Cleanup
rm -f "$CERT_DIR/server.csr" "$CERT_DIR/server.ext"

echo "---"
echo "Certificates in $CERT_DIR/"
echo "SAN: $(openssl x509 -in "$CERT_DIR/server.crt" -noout -ext subjectAltName | tr '\n' ' ')"
echo ""
echo "Install CA on iOS (only if not already trusted):"
echo "  1. Serve $CERT_DIR/ca.pem via web or email to device"
echo "  2. Open on iOS → Settings → Profile Downloaded → Install"
echo "  3. Settings → General → About → Certificate Trust Settings → enable \"HearthConnect CA\""
echo ""
echo "Server cert:  $CERT_DIR/server.crt"
echo "Server key:   $CERT_DIR/server.key"
echo "CA cert:      $CERT_DIR/ca.pem"
echo "CA key:       $CERT_DIR/ca.key (keep safe)"
