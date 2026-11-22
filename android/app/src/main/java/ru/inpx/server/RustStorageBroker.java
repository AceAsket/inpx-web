package ru.inpx.server;

import android.net.LocalServerSocket;
import android.net.LocalSocket;
import android.os.ParcelFileDescriptor;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.FileDescriptor;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.ArrayBlockingQueue;
import org.json.JSONObject;

/** Same-UID, read-only broker. SCM_RIGHTS preserves SAF and SMB random access. */
final class RustStorageBroker implements AutoCloseable {
  final String name = "inpx-storage-" + UUID.randomUUID();
  private final LocalServerSocket server;
  private final StorageBridge storage;
  private final Set<LocalSocket> clients = ConcurrentHashMap.newKeySet();
  private final ThreadPoolExecutor workers = new ThreadPoolExecutor(
      2, 4, 30, TimeUnit.SECONDS, new ArrayBlockingQueue<>(16));
  private volatile boolean closed;
  private volatile int rustPid;

  RustStorageBroker(StorageBridge storage) throws IOException {
    this.storage = storage;
    server = new LocalServerSocket(name);
    Thread listener = new Thread(this::accept, "inpx-storage-broker");
    listener.setDaemon(true);
    listener.start();
  }

  private void accept() {
    while (!closed) {
      try {
        LocalSocket client = server.accept();
        clients.add(client);
        try { workers.execute(() -> serve(client)); }
        catch (java.util.concurrent.RejectedExecutionException e) { release(client); }
      } catch (IOException e) { if (!closed) close(); }
    }
  }

  private void serve(LocalSocket client) {
    try {
      client.setSoTimeout(15000);
      if (client.getPeerCredentials().getUid() != android.os.Process.myUid()) return;
      rustPid = client.getPeerCredentials().getPid();
      DataInputStream input = new DataInputStream(client.getInputStream());
      int length = input.readInt();
      if (length < 1 || length > 16384) throw new IOException("Invalid broker request");
      byte[] bytes = new byte[length];
      input.readFully(bytes);
      JSONObject request = new JSONObject(new String(bytes, StandardCharsets.UTF_8));
      String operation = request.getString("operation");
      if (!operation.equals("hello") && !operation.equals("stat") && !operation.equals("list") && !operation.equals("open"))
        throw new IOException("Invalid storage operation");
      JSONObject response = operation.equals("hello") ? new JSONObject().put("value", true)
          : new JSONObject(storage.call(operation, request.getString("path")));
      // Adopt immediately: every failure and disconnect must close the detached descriptor.
      try (ParcelFileDescriptor file = operation.equals("open") && response.has("value")
          ? ParcelFileDescriptor.adoptFd(response.getInt("value")) : null) {
        if (file != null) {
          client.setFileDescriptorsForSend(new FileDescriptor[] {file.getFileDescriptor()});
          response.put("value", true);
        }
        byte[] body = response.toString().getBytes(StandardCharsets.UTF_8);
        if (body.length > 8 * 1024 * 1024) throw new IOException("Storage listing too large");
        DataOutputStream output = new DataOutputStream(client.getOutputStream());
        output.writeInt(body.length);
        output.write(body);
        output.flush();
        client.setFileDescriptorsForSend(null);
      }
    } catch (Exception ignored) {
      // Errors from the source are returned as structured StorageBridge failures.
    } finally { release(client); }
  }

  private void release(LocalSocket client) {
    clients.remove(client);
    try { client.close(); } catch (IOException ignored) {}
  }

  long rssBytes() {
    if (closed || rustPid <= 0) return 0;
    try (java.io.BufferedReader reader = new java.io.BufferedReader(
        new java.io.FileReader("/proc/" + rustPid + "/status"))) {
      String line;
      while ((line = reader.readLine()) != null)
        if (line.startsWith("VmRSS:")) return Long.parseLong(line.substring(6).trim().split("\\s+")[0]) * 1024;
    } catch (Exception ignored) {}
    return 0;
  }

  @Override public void close() {
    closed = true;
    try { server.close(); } catch (IOException ignored) {}
    for (LocalSocket client : clients) release(client);
    workers.shutdownNow();
  }
}
