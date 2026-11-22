package ru.inpx.server;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

/** Detects unapplied source edits without persisting credentials in the service control file. */
final class SourceVersion {
  static String of(String sources) throws Exception {
    byte[] hash =
        MessageDigest.getInstance("SHA-256").digest(sources.getBytes(StandardCharsets.UTF_8));
    StringBuilder value = new StringBuilder();
    for (byte b : hash) value.append(String.format(java.util.Locale.ROOT, "%02x", b & 255));
    return value.toString();
  }
}
