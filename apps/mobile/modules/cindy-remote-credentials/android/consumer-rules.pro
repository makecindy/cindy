# Nimbus JOSE JWT 10.9.1 optionally uses Tink for XC20P content encryption.
# CredentialCrypto.kt creates and accepts only ECDH-ES + A256GCM (JCA-backed),
# so this optional backend is not shipped. Revisit this rule and the dependency
# if the credential protocol ever enables XC20P; do not suppress other classes.
# https://connect2id.com/products/nimbus-jose-jwt/examples/jwe-with-xc20p
-dontwarn com.google.crypto.tink.subtle.XChaCha20Poly1305
