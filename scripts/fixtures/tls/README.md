This self-signed certificate and private key are public test fixtures for a loopback
HTTPS server. They are not deployment credentials and must never be used in production.
The regression test checks rejection by the default trust store and acceptance when
this certificate is explicitly supplied as the CA.
