package ru.inpx.server;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.SystemClock;
import android.provider.DocumentsContract;
import java.io.File;
import java.nio.file.Files;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;

/** Destructive fixtures are restricted to the isolated test application, never the real server. */
final class RustFullChecks {
  private static final int PORT = 22382;
  private final RustSmokeInstrumentation test;
  private final Context context;
  RustFullChecks(RustSmokeInstrumentation test) { this.test = test; context = test.getTargetContext(); }

  void cancellation() throws Exception {
    File fixture = new File(context.getFilesDir(), "rust-cancellation-fixture");
    fixture.mkdirs();
    try (java.util.zip.ZipOutputStream zip = new java.util.zip.ZipOutputStream(
        new java.io.BufferedOutputStream(new java.io.FileOutputStream(new File(fixture, "large.inpx"))))) {
      zip.putNextEntry(new java.util.zip.ZipEntry("structure.info"));
      zip.write("AUTHOR;GENRE;TITLE;SERIES;SERNO;FILE;SIZE;LIBID;DEL;EXT;DATE;LANG;LIBRATE;KEYWORDS;FOLDER".getBytes(java.nio.charset.StandardCharsets.UTF_8));
      zip.closeEntry();
      zip.putNextEntry(new java.util.zip.ZipEntry("large.inp"));
      for (int i = 1; i <= 200000; i++) {
        String row = "Rust,INPX:\u0004comp_soft:\u0004Test " + i + "\u0004\u00040\u0004" + i
            + "\u00041000\u0004" + i + "\u00040\u0004fb2\u00042026-11-22\u0004ru\u00040\u0004\u0004books.zip\n";
        zip.write(row.getBytes(java.nio.charset.StandardCharsets.UTF_8));
      }
      zip.closeEntry();
    }
    String original = Vault.read(context);
    try {
      test.stopServer();
      Vault.write(context, new JSONArray().put(new JSONObject().put("id", "rust-cancel")
          .put("name", "Cancellation fixture").put("kind", "local").put("path", fixture.getAbsolutePath())).toString());
      ServerControl.start(context, false, PORT);
      ServerControl.requestService(context);
      RustSmokeInstrumentation.await(test::indexing, 30000, "Did not observe active indexing");
      long started = SystemClock.elapsedRealtime();
      test.stopServer();
      if (SystemClock.elapsedRealtime() - started > 15000) throw new AssertionError("Cancellation took too long");
      Bundle progress = new Bundle(); progress.putString("stream", "Cancelled indexing of 200000 records in "
          + (SystemClock.elapsedRealtime() - started) + " ms"); test.sendStatus(0, progress);
    } finally { test.stopServer(); Vault.write(context, original); }
    test.startServer(true);
    RustSmokeInstrumentation.await(() -> {
      File sample = new File(context.getFilesDir(), "data/memory.json");
      return sample.exists() && new JSONObject(Io.read(sample)).optLong("rss") > 0;
    }, 15000, "Rust memory sample missing");
    test.books(false);
  }

  void sources() throws Exception {
    if (!context.getPackageName().equals("ru.inpx.server.rust")) throw new AssertionError("Unsafe target");
    String testPackage = context.getPackageName() + ".test";
    Uri control = Uri.parse("content://" + testPackage + ".storage");
    context.startActivity(new Intent().setClassName(testPackage, FixtureGrantActivity.class.getName())
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
    RustSmokeInstrumentation.await(() -> context.checkUriPermission(control, android.os.Process.myPid(),
        android.os.Process.myUid(), Intent.FLAG_GRANT_READ_URI_PERMISSION)
        == android.content.pm.PackageManager.PERMISSION_GRANTED, 5000, "Missing fixture URI grant");
    String hash = Io.read(context.getAssets().open("runtime.sha256")).trim();
    File demo = new File(context.getFilesDir(), "runtime/" + hash + "/demo");
    for (String name : new String[] {"demo.inpx", "books.zip", "books.7z"}) {
      Bundle data = new Bundle();
      data.putByteArray("bytes", Files.readAllBytes(new File(demo, name).toPath()));
      context.getContentResolver().call(control, "fixture-put", name, data);
    }
    context.getContentResolver().call(control, "fixture-mode", "online", null);
    JSONObject tree = new JSONObject().put("id", "rust-saf").put("kind", "tree").put("name", "Rust SAF fixture")
        .put("uri", DocumentsContract.buildTreeDocumentUri(control.getAuthority(), "root").toString());
    String original = Vault.read(context);
    try {
      test.stopServer();
      Vault.write(context, new JSONArray().put(tree).toString());
      test.startServer(false);
      test.books(false);
      // A disconnected document provider must return a clear error, then recover stale IDs.
      context.getContentResolver().call(control, "fixture-mode", "offline", null);
      test.expectMissingBook();
      test.stopServer();
      test.startServer(false);
      test.expectMissingBook();
      context.getContentResolver().call(control, "fixture-mode", "online", null);
      test.books(false);
      JSONObject smb = new JSONObject().put("id", "rust-smb").put("kind", "smb").put("name", "Rust SMB fixture")
          .put("host", "127.0.0.1:1445").put("share", "books").put("user", "inpx-test")
          .put("password", "android-test");
      test.stopServer();
      Vault.write(context, new JSONArray().put(smb).toString());
      test.startServer(false);
      test.books(false);
    } finally {
      test.stopServer();
      context.getContentResolver().call(control, "fixture-mode", "online", null);
      Vault.write(context, original);
    }
  }

  void reader() throws Exception {
    if (!EmbeddedReader.available(context)) throw new AssertionError("Reader missing");
    Activity catalog = test.startActivitySync(new Intent().setClassName(context, "ru.inpx.reader.MainActivity")
        .putExtra("ru.inpx.reader.LOCAL_PORT", PORT).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
    Object app = context.getApplicationContext();
    Object connections = app.getClass().getField("connections").get(app);
    RustSmokeInstrumentation.await(() -> connections.getClass().getMethod("currentOrNull").invoke(connections) != null,
        15000, "Embedded reader did not connect");
    Object repository = app.getClass().getField("catalog").get(app);
    Object page = repository.getClass().getMethod("search", String.class, boolean.class, int.class)
        .invoke(repository, "Проверка ZIP", false, 0);
    List<?> books = (List<?>) page.getClass().getField("books").get(page);
    if (books.size() != 1) throw new AssertionError("Reader catalog mismatch");
    Object library = app.getClass().getField("library").get(app);
    library.getClass().getMethod("download", Class.forName("ru.inpx.reader.domain.BookItem"), String.class)
        .invoke(library, books.get(0), "");
    Object store = Class.forName("ru.inpx.reader.LibraryStore").getConstructor(Context.class).newInstance(context);
    String[] key = {""};
    RustSmokeInstrumentation.await(() -> {
      List<?> rows = (List<?>) store.getClass().getMethod("list").invoke(store);
      for (Object row : rows) {
        JSONObject book = (JSONObject) row;
        if (book.optString("state").equals("error")) throw new AssertionError(book.optString("message"));
        if (book.optString("state").equals("ready")) { key[0] = book.getString("key"); return true; }
      }
      return false;
    }, 45000, "Reader download failed");
    File document = (File) store.getClass().getMethod("document", String.class).invoke(store, key[0]);
    if (!Io.read(document).contains("Библиотека работает")) throw new AssertionError("Reader content missing");
    test.stopServer();
    Activity reading = test.startActivitySync(new Intent().setClassName(context, "ru.inpx.reader.ReaderActivity")
        .putExtra("key", key[0]).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
    SystemClock.sleep(1000);
    test.runOnMainSync(() -> {
      if (!nativeView(reading.getWindow().getDecorView())) throw new AssertionError("Native reading view missing");
      reading.finish(); catalog.finish();
    });
    test.startServer(true);
  }

  private static boolean nativeView(android.view.View view) {
    if (view.getClass().getName().equals("ru.inpx.reader.ui.reading.NativeReadingView")
        && view.getVisibility() == android.view.View.VISIBLE && view.getHeight() > 0) return true;
    if (view instanceof android.view.ViewGroup) {
      android.view.ViewGroup group = (android.view.ViewGroup) view;
      for (int i = 0; i < group.getChildCount(); i++) if (nativeView(group.getChildAt(i))) return true;
    }
    return false;
  }
}
