package ru.inpx.server;

import android.content.Context;
import android.content.ContextWrapper;
import android.content.SharedPreferences;
import java.io.File;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONObject;
import ru.inpx.server.presentation.DashboardState;
import ru.inpx.server.presentation.SourceDraft;

/**
 * Exercises the real encrypted repository in isolated preferences/files, never the user's vault.
 */
final class RepositoryChecks {
  static JSONObject run(Context target) throws Exception {
    String prefix = "repository-check-" + UUID.randomUUID() + "-";
    File directory = new File(target.getCacheDir(), prefix);
    if (!directory.mkdirs()) throw new Exception("Cannot create isolated repository fixture");
    Context fixture =
        new ContextWrapper(target) {
          @Override
          public Context getApplicationContext() {
            return this;
          }

          @Override
          public File getFilesDir() {
            return directory;
          }

          @Override
          public SharedPreferences getSharedPreferences(String name, int mode) {
            return target.getSharedPreferences(prefix + name, mode);
          }

          @Override
          public Object getSystemService(String name) {
            return Context.ACTIVITY_SERVICE.equals(name) ? null : super.getSystemService(name);
          }
        };
    JSONArray checks = new JSONArray();
    try {
      AndroidServerRepository repository = new AndroidServerRepository(fixture);
      repository.saveSource(SourceDraft.tree("first", "First", "content://fixture/first"));
      repository.saveSource(
          new SourceDraft(
              "nas",
              "smb",
              "NAS",
              "",
              "nas.local",
              "books",
              "collection",
              "reader",
              " Пароль 🔒 ",
              "WORKGROUP"));
      SourceDraft stale = repository.source("nas");
      repository.removeSource("first"); // NAS now occupies another list position.
      repository.saveSource(stale.renamed("Renamed NAS"));
      DashboardState state = repository.load();
      require(
          state.sources.size() == 1 && state.sources.get(0).id.equals("nas"),
          "Editing by ID after removal preserves the intended source",
          checks);
      SourceDraft saved = repository.source("nas");
      require(
          saved.name.equals("Renamed NAS")
              && saved.password.equals(" Пароль 🔒 ")
              && saved.folder.equals("collection")
              && saved.user.equals("reader"),
          "Rename preserves SMB credentials and path exactly",
          checks);
      String encrypted = fixture.getSharedPreferences("sources", 0).getString("encrypted", "");
      require(
          !encrypted.contains("Пароль")
              && !encrypted.contains("nas.local")
              && !encrypted.contains("reader"),
          "Source settings are encrypted at rest",
          checks);
      String before = Vault.read(fixture);
      try {
        repository.saveSource(SourceDraft.tree("bad", "", "content://fixture/bad"));
        throw new AssertionError("Invalid source accepted");
      } catch (IllegalArgumentException expected) {
      }
      require(
          before.equals(Vault.read(fixture)),
          "Failed validation leaves the previous vault unchanged",
          checks);
      repository.savePort(12400);
      repository.saveMode("tv");
      state = repository.load();
      require(
          state.preferredPort == 12400 && state.uiMode.equals("tv"),
          "Settings round-trip through the repository",
          checks);
      File oldStatus = new File(directory, "status.txt");
      Io.write(oldStatus, "Ошибка прошлого запуска");
      oldStatus.setLastModified(System.currentTimeMillis() - 60000);
      ServerControl.start(fixture, false, 12400);
      require(
          repository.load().phase == DashboardState.Phase.STARTING,
          "Retry ignores stale errors from the previous launch",
          checks);
      repository.removeSource("nas");
      require(
          repository.load().sources.isEmpty(),
          "Removing the last source returns the first-run state",
          checks);
      return new JSONObject().put("passed", true).put("checks", checks);
    } finally {
      target.deleteSharedPreferences(prefix + "sources");
      target.deleteSharedPreferences(prefix + "MainActivity");
      File[] files = directory.listFiles();
      if (files != null)
        for (File file : files) {
          if (file.isDirectory()) {
            File[] children = file.listFiles();
            if (children != null) for (File child : children) if (child.isFile()) child.delete();
          }
          file.delete();
        }
      directory.delete();
    }
  }

  private static void require(boolean value, String message, JSONArray checks) {
    if (!value) throw new AssertionError(message);
    checks.put(message);
  }
}
