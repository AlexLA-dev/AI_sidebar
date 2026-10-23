#!/usr/bin/env bash
# Generates a throwaway EC P-256 certificate chain shaped like Apple's StoreKit
# signing chain (root → WWDR-like intermediate → App Store leaf, with Apple's
# marker OIDs) so the JWS verifier can be tested offline. Test data only.
set -euo pipefail
cd "$(dirname "$0")"
gen() { openssl ecparam -name prime256v1 -genkey -noout -out "$1.key"; }
gen root; gen intermediate; gen leaf; gen rogue

cat > ext.cnf <<'CNF'
[root]
basicConstraints=critical,CA:TRUE
keyUsage=critical,keyCertSign,cRLSign
[intermediate]
basicConstraints=critical,CA:TRUE,pathlen:0
keyUsage=critical,keyCertSign,cRLSign
1.2.840.113635.100.6.2.1=ASN1:NULL
[leaf]
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
1.2.840.113635.100.6.11.1=ASN1:NULL
[rogue]
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
CNF

openssl req -new -x509 -key root.key -subj "/CN=Test Root CA G3" -days 3650 -extensions root -config <(cat /etc/ssl/openssl.cnf ext.cnf) -out root.pem 2>/dev/null \
  || openssl req -new -x509 -key root.key -subj "/CN=Test Root CA G3" -days 3650 -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" -out root.pem
for name in intermediate leaf rogue; do
  issuer=root; [ "$name" = intermediate ] || issuer=intermediate
  openssl req -new -key "$name.key" -subj "/CN=Test $name" -out "$name.csr"
  openssl x509 -req -in "$name.csr" -CA "$issuer.pem" -CAkey "$issuer.key" -CAcreateserial -days 3000 \
    -extfile ext.cnf -extensions "$name" -out "$name.pem" 2>/dev/null
done
rm -f ./*.csr ./*.srl ext.cnf root.key intermediate.key
