package ru.inpx.server;

import android.content.Context;
import android.net.Uri;
import android.os.Bundle;
import android.os.ParcelFileDescriptor;
import android.os.SystemClock;
import android.provider.DocumentsContract;
import java.io.File;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.file.Files;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONObject;

/** Real SAF provider and SMB sockets, with generated fixtures and no Vault mutations. */
final class StorageChecks {
  private static final Uri CONTROL = Uri.parse("content://ru.inpx.server.test.storage");

  private static void mode(Context context, String value) {
    context.getContentResolver().call(CONTROL, "fixture-mode", value, null);
  }

  private static void put(Context context, String name, byte[] bytes) {
    Bundle value = new Bundle();
    value.putByteArray("bytes", bytes);
    context.getContentResolver().call(CONTROL, "fixture-put", name, value);
  }

  private static JSONObject control(String operation) throws Exception {
    HttpURLConnection connection =
        (HttpURLConnection) new URL("http://127.0.0.1:1446/" + operation).openConnection();
    connection.setRequestMethod("POST");
    connection.setConnectTimeout(3000);
    connection.setReadTimeout(15000);
    try {
      if (connection.getResponseCode() != 200)
        throw new AssertionError("Fixture controller: " + operation);
      return new JSONObject(Io.read(connection.getInputStream()));
    } finally {
      connection.disconnect();
    }
  }

  private static JSONObject call(StorageBridge bridge, String op, String path) throws Exception {
    return new JSONObject(bridge.call(op, path));
  }

  private static ParcelFileDescriptor descriptor(StorageBridge bridge, String path)
      throws Exception {
    JSONObject value = call(bridge, "open", path);
    if (value.has("error")) throw new AssertionError(value);
    return ParcelFileDescriptor.adoptFd(value.getInt("value"));
  }

  private static byte[] read(StorageBridge bridge, String path) throws Exception {
    try (InputStream input =
        new ParcelFileDescriptor.AutoCloseInputStream(descriptor(bridge, path))) {
      java.io.ByteArrayOutputStream output = new java.io.ByteArrayOutputStream();
      byte[] buffer = new byte[8192];
      int n;
      while ((n = input.read(buffer)) != -1) output.write(buffer, 0, n);
      return output.toByteArray();
    }
  }

  private static void probe(FileChannel file, long position) throws Exception {
    ByteBuffer data = ByteBuffer.allocate(32);
    file.position(position);
    if (file.read(data) != 32) throw new AssertionError("Short proxy read");
    for (int i = 0; i < 32; i++)
      if ((data.array()[i] & 255) != (position + i) % 251)
        throw new AssertionError("Wrong resumed offset");
  }

  private static void require(boolean success, String name, JSONArray checks) {
    if (!success) throw new AssertionError(name);
    checks.put(name);
  }

  static JSONObject run(Context context) throws Exception {
    JSONObject report = new JSONObject();
    JSONArray checks = new JSONArray();
    report.put("checks", checks);
    context.startActivity(
        new android.content.Intent()
            .setClassName("ru.inpx.server.test", "ru.inpx.server.FixtureGrantActivity")
            .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK));
    long grantDeadline = SystemClock.elapsedRealtime() + 5000;
    while (context.checkUriPermission(
            CONTROL,
            android.os.Process.myPid(),
            android.os.Process.myUid(),
            android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION)
        != android.content.pm.PackageManager.PERMISSION_GRANTED) {
      if (SystemClock.elapsedRealtime() > grantDeadline)
        throw new AssertionError("Fixture grant activity did not finish");
      SystemClock.sleep(50);
    }
    String treeId = "reconnect-test-tree",
        smbId = "reconnect-test-smb",
        localId = "reconnect-test-local",
        missingId = "reconnect-test-missing",
        authId = "reconnect-test-auth",
        shareId = "reconnect-test-share";
    Set<String> ids =
        new HashSet<>(Arrays.asList(treeId, smbId, localId, missingId, authId, shareId));
    StorageBridge bridge = null;
    java.util.concurrent.ExecutorService worker = Executors.newSingleThreadExecutor();
    try {
      String hash;
      try (InputStream input = context.getAssets().open("runtime.sha256")) {
        hash = Io.read(input).trim();
      }
      File demo = new File(context.getFilesDir(), "runtime/" + hash + "/demo");
      byte[] index = Files.readAllBytes(new File(demo, "demo.inpx").toPath());
      byte[] zip = Files.readAllBytes(new File(demo, "zip-books.zip").toPath());
      put(context, "demo.inpx", index);
      put(context, "zip-books.zip", zip);
      mode(context, "online");
      JSONObject tree =
          new JSONObject()
              .put("id", treeId)
              .put("name", "SAF test")
              .put("kind", "tree")
              .put(
                  "uri",
                  DocumentsContract.buildTreeDocumentUri(CONTROL.getAuthority(), "root")
                      .toString());
      JSONObject local =
          new JSONObject()
              .put("id", localId)
              .put("name", "Local test")
              .put("kind", "local")
              .put("path", demo.getAbsolutePath());
      JSONObject smb =
          new JSONObject()
              .put("id", smbId)
              .put("name", "SMB test")
              .put("kind", "smb")
              .put("host", "127.0.0.1:1445")
              .put("share", "books")
              .put("user", "inpx-test")
              .put("password", "android-test");
      JSONObject missing =
          new JSONObject()
              .put("id", missingId)
              .put("name", "Missing test")
              .put("kind", "local")
              .put("path", new File(demo, "does-not-exist").getAbsolutePath());
      JSONArray sources = new JSONArray().put(tree).put(local).put(smb).put(missing);
      control("online");
      bridge = new StorageBridge(context, sources);
      require(
          IndexCache.refresh(context, bridge, sources).length() == 3,
          "An uncached offline source does not block healthy sources",
          checks);
      require(
          Arrays.equals(zip, read(bridge, StorageBridge.PREFIX + treeId + "/zip-books.zip")),
          "SAF granted descriptor reads real generated archive",
          checks);
      mode(context, "online");
      require(
          Arrays.equals(zip, read(bridge, StorageBridge.PREFIX + treeId + "/zip-books.zip")),
          "SAF stale document IDs are resolved again without reselecting folder",
          checks);
      File cached = new File(context.getFilesDir(), "source-indexes/" + treeId + ".inpx");
      byte[] previous = Files.readAllBytes(cached.toPath());
      mode(context, "offline");
      IndexCache.refresh(context, bridge, sources);
      JSONObject health = SourceHealth.find(SourceHealth.read(context), treeId);
      require(
          !health.optBoolean("online")
              && health.optBoolean("cachedIndex")
              && health.optString("code").equals("ENODEV")
              && Arrays.equals(previous, Files.readAllBytes(cached.toPath())),
          "SAF disconnect reports unavailable storage and preserves valid INPX",
          checks);
      mode(context, "denied");
      IndexCache.refresh(context, bridge, sources);
      require(
          SourceHealth.find(SourceHealth.read(context), treeId).optString("code").equals("EACCES"),
          "Revoked SAF access reports reselect-folder action",
          checks);
      mode(context, "online");
      IndexCache.refresh(context, bridge, sources);
      require(
          SourceHealth.find(SourceHealth.read(context), treeId).optBoolean("online"),
          "SAF reconnect returns source to online",
          checks);
      put(context, "demo.inpx", new byte[] {1, 2, 3});
      IndexCache.refresh(context, bridge, sources);
      require(
          SourceHealth.find(SourceHealth.read(context), treeId).optString("code").equals("EINDEX")
              && Arrays.equals(previous, Files.readAllBytes(cached.toPath())),
          "Invalid replacement INPX cannot overwrite the saved catalogue",
          checks);
      put(context, "demo.inpx", index);
      IndexCache.refresh(context, bridge, sources);
      java.io.ByteArrayOutputStream broken = new java.io.ByteArrayOutputStream();
      byte[] contents = "CRC validation fixture".getBytes(java.nio.charset.StandardCharsets.UTF_8);
      java.util.zip.CRC32 crc = new java.util.zip.CRC32();
      crc.update(contents);
      try (java.util.zip.ZipOutputStream output = new java.util.zip.ZipOutputStream(broken)) {
        java.util.zip.ZipEntry entry = new java.util.zip.ZipEntry("books.inp");
        entry.setMethod(java.util.zip.ZipEntry.STORED);
        entry.setSize(contents.length);
        entry.setCrc(crc.getValue());
        output.putNextEntry(entry);
        output.write(contents);
        output.closeEntry();
      }
      byte[] corruptPayload = broken.toByteArray();
      corruptPayload[30 + "books.inp".length()] ^= 1;
      put(context, "demo.inpx", corruptPayload);
      IndexCache.refresh(context, bridge, sources);
      require(
          SourceHealth.find(SourceHealth.read(context), treeId).optString("code").equals("EINDEX")
              && Arrays.equals(previous, Files.readAllBytes(cached.toPath())),
          "INPX with valid ZIP structure but wrong payload CRC cannot replace saved catalogue",
          checks);
      put(context, "demo.inpx", index);
      IndexCache.refresh(context, bridge, sources);
      final StorageBridge active = bridge;
      control("stall");
      try {
        java.util.concurrent.Future<JSONObject> waiting =
            worker.submit(
                () -> call(active, "stat", StorageBridge.PREFIX + smbId + "/reconnect-probe.bin"));
        SystemClock.sleep(250);
        require(!waiting.isDone(), "SMB fixture is deliberately waiting for a response", checks);
        long started = SystemClock.elapsedRealtime();
        byte[] localZip = read(bridge, StorageBridge.PREFIX + localId + "/zip-books.zip");
        long elapsed = SystemClock.elapsedRealtime() - started;
        require(
            Arrays.equals(zip, localZip) && elapsed < 2000,
            "Waiting NAS does not block local source",
            checks);
        report.put("localReadDuringStallMs", elapsed);
        control("online");
        require(
            !waiting.get(30, TimeUnit.SECONDS).has("error"),
            "SMB request completes after server resumes",
            checks);
      } finally {
        control("online");
      }
      try (java.io.FileInputStream input =
          new ParcelFileDescriptor.AutoCloseInputStream(
              descriptor(bridge, StorageBridge.PREFIX + smbId + "/reconnect-probe.bin"))) {
        probe(input.getChannel(), 0);
        JSONObject first = control("online");
        control("offline");
        boolean failed = false;
        try {
          probe(input.getChannel(), 2 * 1024 * 1024);
        } catch (java.io.IOException e) {
          failed = true;
        }
        require(failed, "SMB descriptor reports read error while NAS is offline", checks);
        IndexCache.refresh(context, bridge, sources);
        health = SourceHealth.find(SourceHealth.read(context), smbId);
        require(
            !health.optBoolean("online")
                && health.optBoolean("cachedIndex")
                && health.optString("code").equals("ENETUNREACH"),
            "SMB disconnect preserves catalogue and reports network cause",
            checks);
        JSONObject second = control("online");
        require(
            first.getInt("pid") != second.getInt("pid"),
            "SMB fixture really restarted in a new process",
            checks);
        probe(input.getChannel(), 4 * 1024 * 1024);
        checks.put("Existing SMB proxy descriptor reconnects and resumes at correct random offset");
      }
      IndexCache.refresh(context, bridge, sources);
      require(
          SourceHealth.find(SourceHealth.read(context), smbId).optBoolean("online")
              && Arrays.equals(zip, read(bridge, StorageBridge.PREFIX + smbId + "/zip-books.zip")),
          "SMB source and archive reads recover without restarting app",
          checks);
      JSONObject bad =
          new JSONObject(smb.toString()).put("id", authId).put("password", "wrong-test-password");
      try (StorageBridge invalid = new StorageBridge(context, new JSONArray().put(bad))) {
        require(
            call(invalid, "list", StorageBridge.PREFIX + authId).optString("error").equals("EAUTH"),
            "Wrong SMB credentials have a distinct authentication status",
            checks);
      }
      bad = new JSONObject(smb.toString()).put("id", shareId).put("share", "missing-share");
      try (StorageBridge invalid = new StorageBridge(context, new JSONArray().put(bad))) {
        require(
            call(invalid, "list", StorageBridge.PREFIX + shareId)
                .optString("error")
                .equals("ESHARE"),
            "Wrong SMB share has a distinct status",
            checks);
      }
      String publicStatus = SourceHealth.read(context).toString();
      require(
          !publicStatus.contains("android-test")
              && !publicStatus.contains("wrong-test-password")
              && !publicStatus.contains("content://"),
          "Diagnostic status contains no passwords or SAF URIs",
          checks);
      report.put("passed", true);
    } catch (Throwable e) {
      report.put("passed", false).put("error", e.toString());
    } finally {
      try {
        control("online");
      } catch (Exception ignored) {
      }
      mode(context, "online");
      worker.shutdownNow();
      if (bridge != null) bridge.close();
      SourceHealth.forget(context, ids);
      for (String id : ids)
        for (String suffix : new String[] {".inpx", ".json", ".pending"})
          new File(context.getFilesDir(), "source-indexes/" + id + suffix).delete();
      Io.write(
          new File(context.getExternalFilesDir(null), "storage-checks.json"), report.toString(2));
    }
    return report;
  }
}
