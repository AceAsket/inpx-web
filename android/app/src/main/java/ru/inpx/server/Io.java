package ru.inpx.server;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

final class Io {
  static String read(File file) throws Exception {
    return new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8);
  }

  static void write(File file, String value) throws Exception {
    Files.write(file.toPath(), value.getBytes(StandardCharsets.UTF_8));
  }

  static void writeAtomic(File file, String value) throws Exception {
    android.util.AtomicFile atomic = new android.util.AtomicFile(file);
    java.io.FileOutputStream output = null;
    try {
      output = atomic.startWrite();
      output.write(value.getBytes(StandardCharsets.UTF_8));
      atomic.finishWrite(output);
    } catch (Exception error) {
      if (output != null) atomic.failWrite(output);
      throw error;
    }
  }

  static String read(InputStream input) throws Exception {
    ByteArrayOutputStream output = new ByteArrayOutputStream();
    byte[] bytes = new byte[8192];
    int n;
    while ((n = input.read(bytes)) != -1) output.write(bytes, 0, n);
    return output.toString("UTF-8");
  }
}
